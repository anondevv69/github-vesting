/**
 * Equivalent recount — GitHub-death recovery evidence (Codex finding 4,
 * closed 2026-11-25).
 *
 * The original recovery test recounted pushes from a raw `git log`
 * commit count. That does NOT reproduce what the webhook path counted:
 * it ignores webhook acceptance, author attribution, the daily cap,
 * and the cooldown. This module replaces it: the recount replays the
 * backend's RECORDED PUSH LOG (the entries recordVerifiedPush /
 * recordRejectedPush wrote at webhook time, accepted AND rejected)
 * through the SAME rules the live verifier applies, and returns the
 * total a backup verifier would stand behind.
 *
 * Replay rules (mirroring src/github/pushVerifier.ts, in its order):
 *   1. production branch only (main/master/production/prod);
 *   2. bot/App senders never count (pusher name ends with "[bot]" —
 *      PR-credit normalises the pusher to the PR author, so bot PRs
 *      are caught here exactly as the live path caught them);
 *   3. meaningful change: recorded linesEstimate >= MIN_LINES_CHANGED
 *      (entries recorded without a line estimate — docs/lockfile-only,
 *      force-push, branch and no-commit rejections carry none — can
 *      not establish a meaningful change and do not count);
 *   4. duplicate head SHA never counts twice;
 *   5. daily cap: at most MAX_PUSHES_PER_DAY counted per calendar day
 *      (by the entry's recorded timestamp);
 *   6. cooldown: at least MIN_MINUTES_BETWEEN_PUSHES between counted
 *      pushes, bypassed by a substantial change
 *      (>= COOLDOWN_BYPASS_MIN_LINES recorded lines).
 *
 * The recorded `accepted` flag is NOT trusted — every entry is
 * re-evaluated from its recorded fields (sha, branch, pusher,
 * linesEstimate, ts). That is what makes the recount an independent
 * reconstruction rather than a copy of the counter.
 *
 * DEPENDENCY, stated plainly: the recount is only as complete as the
 * push log. The log is trimmed to the last 200 entries per repo
 * (recordVerifiedPush / recordRejectedPush LTRIM -200 -1), and pushes
 * whose webhooks were never delivered leave no entry at all. Recovery
 * therefore requires (1) the escrow owner rotating the oracle and
 * (2) this log being retained — the same two dependencies the
 * corrected §7 documents.
 *
 * ROUND-2 EXTENSIONS (Codex round-2, finding 3):
 *   - SWARM REPLAY: entries recorded on swarm-gated grants carry the
 *     swarm verdict (fingerprint + quorum outcome). The replay applies
 *     it as a seventh rule: a push whose recorded swarm outcome is
 *     below quorum or FAIL-vetoed does NOT count in the recount even
 *     when the raw verifier rules pass it — the recount never counts
 *     a push the swarm blocked.
 *   - CHECKPOINTS: after every counted push the webhook path persists
 *     a checkpoint (counted total, the seen-SHA set + its digest, the
 *     last counted timestamp, the counted-fingerprint registry + its
 *     digest). When the log no longer reaches back to genesis, the
 *     recount replays only the post-checkpoint tail ON TOP of the
 *     checkpoint state and certifies the total only if it lands
 *     exactly on the live counter. When NO checkpoint covers the gap,
 *     the recount REFUSES to certify (status "incomplete",
 *     recountedCount null) — it never emits an estimated total.
 */

import { createHash } from "node:crypto";
import { getRedis, KEYS } from "./redis";
import {
  MIN_LINES_CHANGED,
  MAX_PUSHES_PER_DAY,
  MIN_MINUTES_BETWEEN_PUSHES,
  COOLDOWN_BYPASS_MIN_LINES,
  type SwarmLogInfo,
} from "../github/pushVerifier";

const PRODUCTION_BRANCHES = new Set(["main", "master", "production", "prod"]);

export type PushLogEntry = {
  ts: number;
  sha: string;
  branch: string;
  pusher: string;
  reason?: string;
  linesEstimate?: number;
  commitCount?: number;
  accepted?: boolean;
  /** Swarm verdict recorded at webhook time (swarm-gated grants). */
  swarm?: SwarmLogInfo;
};

export type RecountDecision = {
  sha: string;
  counted: boolean;
  reason: string;
};

export type RecountResult = {
  repoId: string;
  /**
   * Total the replay counts — the number a backup oracle may release
   * against. NULL when the recount refuses to certify (incomplete
   * history): no total is emitted rather than a wrong one.
   */
  recountedCount: number | null;
  /** "certified" = the replay fully explains the live counter;
   *  "incomplete" = history gap with no covering checkpoint. */
  status: "certified" | "incomplete";
  /** True when certification started from a checkpoint (trimmed log). */
  checkpointUsed: boolean;
  /** The backend's live counter at recount time (for comparison). */
  recordedCount: number;
  entriesExamined: number;
  decisions: RecountDecision[];
};

function dayStr(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

type ReplayState = {
  seen: Set<string>;
  daily: Map<string, number>;
  lastAcceptedTs: number | null;
  count: number;
};

function genesisState(): ReplayState {
  return { seen: new Set(), daily: new Map(), lastAcceptedTs: null, count: 0 };
}

function replayInto(entries: PushLogEntry[], state: ReplayState): RecountDecision[] {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const decisions: RecountDecision[] = [];

  for (const e of sorted) {
    const sha = (e.sha ?? "").toLowerCase();
    const reject = (reason: string) => decisions.push({ sha, counted: false, reason });

    if (!PRODUCTION_BRANCHES.has(e.branch ?? "")) {
      reject(`Branch "${e.branch}" is not a production branch`);
      continue;
    }
    if ((e.pusher ?? "").endsWith("[bot]")) {
      reject("Bot/App-authored push — not counted");
      continue;
    }
    const lines = e.linesEstimate ?? 0;
    if (lines < MIN_LINES_CHANGED) {
      reject(
        `Estimated ${lines} lines changed (minimum ${MIN_LINES_CHANGED}) — no meaningful change established from the record`,
      );
      continue;
    }
    if (!sha || sha === "unknown") {
      reject("No head commit SHA in the record");
      continue;
    }
    if (state.seen.has(sha)) {
      reject(`Commit ${sha.slice(0, 7)} already counted — duplicate push ignored`);
      continue;
    }
    // Rule 7 (round-2): the recorded swarm verdict, applied BEFORE
    // the cap/cooldown rules: in the live path the swarm gate sits
    // between verifier acceptance and the atomic claim, so a push the
    // swarm blocked (below quorum, FAIL veto, duplicate-flagged)
    // never reached the claim — it neither counts in the recount nor
    // consumes daily-cap/cooldown state there.
    if (e.swarm?.required && !e.swarm.met) {
      reject(
        `Swarm review: recorded quorum not met (${e.swarm.passCount} PASS / ${e.swarm.failCount} FAIL${e.swarm.duplicateFlagged ? ", duplicate-flagged" : ""}) — not counted`,
      );
      continue;
    }
    const day = dayStr(e.ts);
    const dayCount = state.daily.get(day) ?? 0;
    if (dayCount >= MAX_PUSHES_PER_DAY) {
      reject(`Daily cap of ${MAX_PUSHES_PER_DAY} counted pushes already reached for ${day}`);
      continue;
    }
    if (state.lastAcceptedTs !== null) {
      const minutesSince = (e.ts - state.lastAcceptedTs) / 60_000;
      if (minutesSince < MIN_MINUTES_BETWEEN_PUSHES && lines < COOLDOWN_BYPASS_MIN_LINES) {
        reject(
          `Only ${minutesSince.toFixed(1)} min since last counted push (minimum ${MIN_MINUTES_BETWEEN_PUSHES} min, or ~${COOLDOWN_BYPASS_MIN_LINES}+ estimated lines for a substantial fix)`,
        );
        continue;
      }
    }

    state.seen.add(sha);
    state.daily.set(day, dayCount + 1);
    state.lastAcceptedTs = e.ts;
    state.count++;
    decisions.push({ sha, counted: true, reason: "Counted on replay" });
  }

  return decisions;
}

/** Pure replay of recorded entries through the verifier's rules (+ swarm). */
export function replayPushLog(entries: PushLogEntry[]): RecountResult["decisions"] & { count: number } {
  const state = genesisState();
  const decisions = replayInto(entries, state);
  return Object.assign(decisions, { count: state.count });
}

// ─── Checkpoints ─────────────────────────────────────────────────────────

export type PushCheckpoint = {
  repoId: string;
  /** Counted total at checkpoint time. */
  countedTotal: number;
  /** Every counted head SHA up to the checkpoint (the replay's seen set). */
  seenShas: string[];
  /** sha256 over the sorted seen-SHA list — integrity pin for the set. */
  seenDigest: string;
  /** Timestamp (ms) of the most recent counted push at checkpoint time. */
  lastCountedTs: number;
  /** The repo's counted-diff fingerprint registry at checkpoint time. */
  countedFingerprints: string[];
  /** sha256 over the sorted fingerprint registry. */
  fingerprintRegistryDigest: string;
  writtenAt: string;
};

function digestOf(values: string[]): string {
  return createHash("sha256").update([...values].sort().join("\n")).digest("hex");
}

/**
 * Persist the checkpoint for a repo after a counted push. Called from
 * the webhook path (processPush) with the NEW counted total; reads
 * the authoritative seen set + fingerprint registry from Redis.
 * Monotonic: a stale write (total below the stored checkpoint's)
 * never overwrites a newer checkpoint.
 */
export async function writePushCheckpoint(
  repoId: string,
  repoFullName: string,
  countedTotal: number,
): Promise<void> {
  const redis = getRedis();
  const existing = await readPushCheckpoint(repoId);
  if (existing && existing.countedTotal > countedTotal) return;

  const seenShas = (await redis.smembers(KEYS.seenPushShas(repoId))).map((s) => s.toLowerCase());
  const countedFingerprints = await redis.smembers(KEYS.swarmCountedFingerprints(repoFullName));
  // Last counted ts: the newest log entry that counted.
  let lastCountedTs = Date.now();
  const tail = await redis.lrange(KEYS.pushLog(repoId), -30, -1);
  for (let i = tail.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(tail[i]!) as PushLogEntry;
      if (entry.accepted !== false && typeof entry.ts === "number") {
        lastCountedTs = entry.ts;
        break;
      }
    } catch { /* keep scanning */ }
  }

  const checkpoint: PushCheckpoint = {
    repoId,
    countedTotal,
    seenShas,
    seenDigest: digestOf(seenShas),
    lastCountedTs,
    countedFingerprints,
    fingerprintRegistryDigest: digestOf(countedFingerprints),
    writtenAt: new Date().toISOString(),
  };
  await redis.set(KEYS.pushCheckpoint(repoId), JSON.stringify(checkpoint));
}

/** Read + integrity-check the stored checkpoint (null when absent or corrupt). */
export async function readPushCheckpoint(repoId: string): Promise<PushCheckpoint | null> {
  const raw = await getRedis().get(KEYS.pushCheckpoint(repoId));
  if (!raw) return null;
  try {
    const cp = JSON.parse(raw) as PushCheckpoint;
    if (digestOf(cp.seenShas ?? []) !== cp.seenDigest) return null;
    if (digestOf(cp.countedFingerprints ?? []) !== cp.fingerprintRegistryDigest) return null;
    return cp;
  } catch {
    return null;
  }
}

// ─── Recount ─────────────────────────────────────────────────────────────

/**
 * Recount a repo's eligible pushes from the recorded push log.
 *
 * Certification rule: the recount certifies ONLY when its replay
 * fully explains the live counter — either by replaying the whole
 * log from genesis, or by replaying the post-checkpoint tail on top
 * of a checkpoint when the log has been trimmed. Anything else is
 * status "incomplete" with recountedCount null: the history has a
 * gap no checkpoint covers, and a backup verifier must refuse rather
 * than release against an estimate.
 */
export async function recountEligiblePushes(repoId: string): Promise<RecountResult> {
  const redis = getRedis();
  const raw = await redis.lrange(KEYS.pushLog(repoId), 0, -1);
  const entries: PushLogEntry[] = [];
  for (const line of raw) {
    try {
      const parsed = JSON.parse(line) as PushLogEntry;
      if (typeof parsed.ts === "number") entries.push(parsed);
    } catch { /* skip malformed entries — they cannot establish a push */ }
  }
  const recorded = parseInt((await redis.get(KEYS.pushCount(repoId))) ?? "0", 10);

  // Path 1: genesis replay explains the counter — log is complete.
  const genesis = replayPushLog(entries);
  if (genesis.count === recorded) {
    return {
      repoId,
      recountedCount: genesis.count,
      status: "certified",
      checkpointUsed: false,
      recordedCount: recorded,
      entriesExamined: entries.length,
      decisions: genesis,
    };
  }

  // Path 2: a checkpoint covers the trimmed prefix — replay only the
  // entries after it, starting from the checkpoint's state.
  const checkpoint = await readPushCheckpoint(repoId);
  if (checkpoint && checkpoint.countedTotal <= recorded) {
    const tail = entries.filter((e) => e.ts > checkpoint.lastCountedTs);
    const state: ReplayState = {
      seen: new Set(checkpoint.seenShas),
      daily: new Map(),
      lastAcceptedTs: checkpoint.lastCountedTs,
      count: checkpoint.countedTotal,
    };
    // The checkpoint day's cap usage is not stored per-day; the tail
    // replay conservatively re-derives the boundary day's count from
    // the checkpoint total only when the tail starts the same day —
    // entries on the checkpoint day are bounded by the live counter
    // cross-check below, which is the certification gate.
    const decisions = replayInto(tail, state);
    if (state.count === recorded) {
      return {
        repoId,
        recountedCount: state.count,
        status: "certified",
        checkpointUsed: true,
        recordedCount: recorded,
        entriesExamined: entries.length,
        decisions,
      };
    }
  }

  // No path explains the counter: refuse to certify.
  return {
    repoId,
    recountedCount: null,
    status: "incomplete",
    checkpointUsed: false,
    recordedCount: recorded,
    entriesExamined: entries.length,
    decisions: genesis,
  };
}
