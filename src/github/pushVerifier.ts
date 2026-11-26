/**
 * Determines whether a GitHub push event contains a real, meaningful code change
 * that should count toward the vesting milestone.
 *
 * Anti-gaming rules:
 *  - Must target the main/production branch (main, master, production, prod).
 *  - Must add or modify ≥ MIN_LINES_CHANGED lines across real code files.
 *  - Markdown-only, lock-file-only, and empty merge commits are rejected.
 *  - Force-pushes are rejected outright: they never count as a milestone push.
 *  - Maximum MAX_PUSHES_PER_DAY counted pushes per calendar day per repo.
 *  - Minimum MIN_MINUTES_BETWEEN_PUSHES minutes between counted pushes (from last accepted push).
 *  - Substantial changes (≥ COOLDOWN_BYPASS_MIN_LINES estimated lines) bypass the cooldown.
 */

import { getRedis, KEYS } from "../lib/redis";

const PRODUCTION_BRANCHES = new Set(["main", "master", "production", "prod"]);
export const MIN_LINES_CHANGED = 3;
export const MAX_PUSHES_PER_DAY = 3;
export const MIN_MINUTES_BETWEEN_PUSHES = 30;
/** Substantial code changes bypass the cooldown (e.g. fixing a broken deploy). */
export const COOLDOWN_BYPASS_MIN_LINES = 50;

/** Files that don't count as meaningful code changes. */
const IGNORED_PATTERNS = [
  /\.md$/i,
  /\.txt$/i,
  /\.lock$/i,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.gitignore$/,
  /\.gitattributes$/,
  /CHANGELOG/i,
  /LICENSE/i,
  /NOTICE/i,
  /^\.proofofdev\//,
  // Ship exclusions (spec §8): policy/claim/workflow-only diffs never count.
  /^\.claude\//,
  /^\.github\//,
];

export type PushPayload = {
  ref: string;
  forced: boolean;
  /** Head commit SHA after the push (GitHub `after` field). */
  after?: string;
  commits: Array<{
    id: string;
    message: string;
    added: string[];
    removed: string[];
    modified: string[];
    timestamp: string;
  }>;
  repository: { full_name: string };
  pusher: { name: string };
  sender?: { login?: string; type?: string };
};

export type VerifyResult =
  | { accepted: true; reason: string; linesEstimate: number }
  | { accepted: false; reason: string; linesEstimate?: number; codeFiles?: number };

/**
 * The reviewer-swarm outcome recorded on a push-log entry (Codex
 * round-2): processPush owns the swarm gate and stamps its verdict
 * onto the entry it records, so the recount (src/lib/recount.ts) can
 * replay swarm decisions — a push the swarm blocked never counts in
 * the recount either, and a counted push's quorum is part of the
 * record a backup verifier re-checks.
 */
export type SwarmLogInfo = {
  /** The grant was swarm-gated at the time of this push. */
  required: boolean;
  /** Diff fingerprint the quorum agreed on (PR-credit path), when known. */
  fingerprint?: string;
  passCount: number;
  failCount: number;
  /** A reviewer/candidate flagged this diff as a duplicate. */
  duplicateFlagged: boolean;
  /** Quorum met: >= required PASS and zero FAIL. */
  met: boolean;
};

function branchFromRef(ref: string): string {
  return ref.replace("refs/heads/", "");
}

export function isMeaningfulFile(path: string): boolean {
  return !IGNORED_PATTERNS.some((p) => p.test(path));
}

/** True when the sender is a bot / GitHub App account (Ship spec §8: bot pushes never count). */
export function isBotSender(payload: PushPayload): boolean {
  const login = payload.sender?.login ?? "";
  const pusher = payload.pusher?.name ?? "";
  return (
    payload.sender?.type === "Bot" ||
    login.endsWith("[bot]") ||
    pusher.endsWith("[bot]")
  );
}

function headCommitSha(payload: PushPayload): string | null {
  if (payload.after) return payload.after.toLowerCase();
  const last = payload.commits[payload.commits.length - 1];
  return last?.id?.toLowerCase() ?? null;
}

function estimateLines(commits: PushPayload["commits"]): number {
  let count = 0;
  for (const c of commits) {
    const files = [...c.added, ...c.modified];
    const meaningful = files.filter(isMeaningfulFile);
    // Each meaningful file change is conservatively estimated at 5 lines if
    // we don't have stats. Real line counts come from the diff API (optional).
    count += meaningful.length * 5;
  }
  return count;
}

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Timestamp of the most recent accepted push in the log (ignores rejected attempts). */
async function lastAcceptedPushTs(repoId: string): Promise<number | null> {
  const redis = getRedis();
  const entries = await redis.lrange(KEYS.pushLog(repoId), -30, -1);
  for (let i = entries.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(entries[i]!) as { ts: number; accepted?: boolean };
      if (entry.accepted !== false) return entry.ts;
    } catch { /* skip malformed */ }
  }
  return null;
}

export async function verifyPush(
  repoId: string,
  payload: PushPayload,
  options?: {
    bypassCooldown?: boolean;
    bypassDailyCap?: boolean;
    platform?: "github" | "gitlawb";
    /** Real diff line count (e.g. from a merged PR's file stats) — overrides the per-file estimate. */
    linesOverride?: number;
  },
): Promise<VerifyResult> {
  const branch = branchFromRef(payload.ref);

  // 1. Must target a production branch.
  if (!PRODUCTION_BRANCHES.has(branch)) {
    return { accepted: false, reason: `Branch "${branch}" is not a production branch` };
  }

  // 1b. Bot / GitHub App senders never count (Ship spec §8).
  if (isBotSender(payload)) {
    return { accepted: false, reason: "Bot/App-authored push — not counted" };
  }

  // 2. Force-pushes don't count (they can erase history).
  if (payload.forced) {
    return { accepted: false, reason: "Force-push detected — not counted" };
  }

  // 3. Must have commits.
  if (!payload.commits || payload.commits.length === 0) {
    return { accepted: false, reason: "No commits in push" };
  }

  // 4. Must have meaningful file changes.
  const allFiles = payload.commits.flatMap((c) => [
    ...c.added,
    ...c.modified,
    ...c.removed,
  ]);
  const meaningfulFiles = allFiles.filter(isMeaningfulFile);
  if (meaningfulFiles.length === 0) {
    return {
      accepted: false,
      reason: "Only docs/lockfiles changed — not counted",
    };
  }

  // 5. Estimate lines changed (GitLawb webhooks omit diff — use adapter estimate).
  //    PR-credit path supplies the merged PR's real diff line count instead.
  const linesEstimate = options?.linesOverride ?? estimateLines(payload.commits);
  const isGitlawb = options?.platform === "gitlawb";
  if (!isGitlawb && linesEstimate < MIN_LINES_CHANGED) {
    return {
      accepted: false,
      reason: `Estimated ${linesEstimate} lines changed (minimum ${MIN_LINES_CHANGED})`,
    };
  }

  // 5. Reject duplicate head commits (same push redelivered or amended
  // re-count). NOTE: this SISMEMBER check is a fast path only — under
  // concurrent deliveries it can pass for two copies of the same push.
  // The authoritative guard is the atomic claim in recordVerifiedPush.
  const headSha = headCommitSha(payload);
  if (!headSha) {
    return { accepted: false, reason: "No head commit SHA in push" };
  }

  const redis = getRedis();
  const seenKey = KEYS.seenPushShas(repoId);
  const alreadySeen = await redis.sismember(seenKey, headSha);
  if (alreadySeen) {
    return {
      accepted: false,
      reason: `Commit ${headSha.slice(0, 7)} already counted — duplicate push ignored`,
      linesEstimate,
      codeFiles: meaningfulFiles.length,
    };
  }

  // 6. Check daily cap.
  const dateStr = todayDateStr();
  const dailyKey = KEYS.dailyCount(repoId, dateStr);
  const dailyCount = parseInt((await redis.get(dailyKey)) ?? "0", 10);
  if (!options?.bypassDailyCap && dailyCount >= MAX_PUSHES_PER_DAY) {
    return {
      accepted: false,
      reason: `Daily cap of ${MAX_PUSHES_PER_DAY} counted pushes already reached for ${dateStr}`,
      linesEstimate,
      codeFiles: meaningfulFiles.length,
    };
  }

  // 7. Cooldown between counted pushes — bypassed for substantial code changes.
  let cooldownBypassed = false;
  if (!options?.bypassCooldown) {
    const lastTs = await lastAcceptedPushTs(repoId);
    if (lastTs !== null) {
      const minutesSince = (Date.now() - lastTs) / 60_000;
      if (minutesSince < MIN_MINUTES_BETWEEN_PUSHES) {
        if (linesEstimate >= COOLDOWN_BYPASS_MIN_LINES) {
          cooldownBypassed = true;
        } else {
          return {
            accepted: false,
            reason:
              `Only ${minutesSince.toFixed(1)} min since last counted push ` +
              `(minimum ${MIN_MINUTES_BETWEEN_PUSHES} min, or ~${COOLDOWN_BYPASS_MIN_LINES}+ estimated lines for a substantial fix)`,
            linesEstimate,
            codeFiles: meaningfulFiles.length,
          };
        }
      }
    }
  }

  return {
    accepted: true,
    reason: isGitlawb
      ? `GitLawb push to ${branch} · commit ${headSha.slice(0, 7)} · ~${linesEstimate} lines (signed)`
      : `${payload.commits.length} commit(s), ~${linesEstimate} lines in ${meaningfulFiles.length} code file(s) on ${branch}` +
        (cooldownBypassed ? " · cooldown bypassed (substantial change)" : ""),
    linesEstimate,
  };
}

/**
 * Atomic claim-and-record Lua script (Codex review fix, 2026-11-25;
 * extended for Codex round-2 finding 4).
 *
 * The duplicate check in verifyPush (SISMEMBER) and the record step
 * used to be separate Redis operations: two concurrent deliveries of
 * the same webhook could BOTH pass the duplicate check before either
 * recorded the SHA, double-counting vesting progress (ShipRewards'
 * per-merge-hash guard stopped a second reward, but the vesting
 * counter itself could inflate). This script makes check-and-record
 * one atomic step.
 *
 * Round 2 closes the remaining race the round-1 script left open:
 * the DAILY CAP and the COOLDOWN were checked in verifyPush against
 * state read BEFORE the claim, so two DIFFERENT pushes racing at the
 * cap boundary (one slot left) could both pass the pre-check and
 * both count, and two pushes inside the cooldown window could both
 * slip through the same way. Both checks now ALSO happen inside this
 * script, against live state, before anything is recorded:
 *   -1  the head SHA was already claimed (duplicate);
 *   -2  the daily counter is already at the cap;
 *   -3  the last counted push in the log tail is inside the cooldown
 *       window and this push is not a substantial-change bypass.
 * On -2/-3 NOTHING is recorded — in particular the SHA is not
 * claimed, so the push can still count when it is legitimately
 * re-delivered after the window/day passes. verifyPush's pre-checks
 * remain as the fast path that produces the friendly reasons; this
 * script is the authoritative guard for all three rules.
 *
 * KEYS[1] = seen-SHA set · KEYS[2] = daily counter · KEYS[3] = push
 * log · KEYS[4] = verified-push counter
 * ARGV[1] = head SHA · ARGV[2] = log entry JSON · ARGV[3] = max
 * daily · ARGV[4] = enforce cap ("1"/"0") · ARGV[5] = cooldown ms ·
 * ARGV[6] = enforce cooldown ("1"/"0") · ARGV[7] = lines estimate ·
 * ARGV[8] = now (ms)
 */
const CLAIM_PUSH_LUA = `
-- claimPush
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
  return -1
end
if ARGV[4] == '1' then
  local daily = tonumber(redis.call('GET', KEYS[2]) or '0')
  if daily >= tonumber(ARGV[3]) then
    return -2
  end
end
if ARGV[6] == '1' and tonumber(ARGV[7]) < 50 then
  local tail = redis.call('LRANGE', KEYS[3], -30, -1)
  for i = #tail, 1, -1 do
    local ok, entry = pcall(cjson.decode, tail[i])
    if ok and entry and entry.accepted ~= false and entry.ts then
      if (tonumber(ARGV[8]) - tonumber(entry.ts)) < tonumber(ARGV[5]) then
        return -3
      end
      break
    end
  end
end
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 172800)
redis.call('RPUSH', KEYS[3], ARGV[2])
redis.call('LTRIM', KEYS[3], -200, -1)
return redis.call('INCR', KEYS[4])
`;

export type ClaimConflict = "duplicate" | "daily-cap" | "cooldown";

/**
 * Record a verified push: { total } with the repo's new verified-push
 * total, or { conflict } when the atomic claim refused it — a
 * concurrent delivery claimed this SHA ("duplicate"), or a DIFFERENT
 * push won the race for the last daily-cap slot / the cooldown
 * window ("daily-cap" / "cooldown"). The caller treats any conflict
 * as a rejection: the push did NOT count. The SISMEMBER/cap/cooldown
 * pre-checks in verifyPush are only a fast path; THIS claim is the
 * authoritative guard for all three rules.
 */
export async function recordVerifiedPush(
  repoId: string,
  payload: PushPayload,
  verifyResult: Extract<VerifyResult, { accepted: true }>,
  opts?: {
    bypassDailyCap?: boolean;
    bypassCooldown?: boolean;
    /** Swarm verdict to stamp onto the recorded entry (recount evidence). */
    swarm?: SwarmLogInfo;
    /** Override "now" (tests); defaults to Date.now(). */
    nowMs?: number;
  },
): Promise<{ total: number } | { conflict: ClaimConflict }> {
  const headSha = headCommitSha(payload) ?? "unknown";
  const redis = getRedis();

  const dateStr = todayDateStr();
  const dailyKey = KEYS.dailyCount(repoId, dateStr);
  const pushCountKey = KEYS.pushCount(repoId);
  const logKey = KEYS.pushLog(repoId);
  const seenKey = KEYS.seenPushShas(repoId);

  const logEntry = JSON.stringify({
    ts: Date.now(),
    sha: headSha,
    branch: branchFromRef(payload.ref),
    pusher: payload.pusher.name,
    reason: verifyResult.reason,
    linesEstimate: verifyResult.linesEstimate,
    commitCount: payload.commits.length,
    accepted: true,
    ...(opts?.swarm ? { swarm: opts.swarm } : {}),
  });

  const result = (await (redis as unknown as {
    eval: (script: string, numKeys: number, ...args: (string | number)[]) => Promise<unknown>;
  }).eval(
    CLAIM_PUSH_LUA,
    4,
    seenKey,
    dailyKey,
    logKey,
    pushCountKey,
    headSha,
    logEntry,
    MAX_PUSHES_PER_DAY,
    opts?.bypassDailyCap ? "0" : "1",
    MIN_MINUTES_BETWEEN_PUSHES * 60_000,
    opts?.bypassCooldown ? "0" : "1",
    verifyResult.linesEstimate,
    opts?.nowMs ?? Date.now(),
  )) as number;

  if (result === -1) return { conflict: "duplicate" };
  if (result === -2) return { conflict: "daily-cap" };
  if (result === -3) return { conflict: "cooldown" };
  return { total: result };
}

/** Log a rejected push attempt so the status page shows why it did not count. */
export async function recordRejectedPush(
  repoId: string,
  payload: PushPayload,
  verifyResult: Extract<VerifyResult, { accepted: false }>,
  extra?: { swarm?: SwarmLogInfo },
): Promise<void> {
  const headSha = headCommitSha(payload) ?? "unknown";
  const logEntry = JSON.stringify({
    ts: Date.now(),
    sha: headSha,
    branch: branchFromRef(payload.ref),
    pusher: payload.pusher?.name ?? "unknown",
    reason: verifyResult.reason,
    accepted: false,
    commitCount: payload.commits?.length ?? 0,
    ...(verifyResult.linesEstimate != null ? { linesEstimate: verifyResult.linesEstimate } : {}),
    ...(verifyResult.codeFiles != null ? { codeFiles: verifyResult.codeFiles } : {}),
    ...(extra?.swarm ? { swarm: extra.swarm } : {}),
  });
  const redis = getRedis();
  const logKey = KEYS.pushLog(repoId);
  await redis.rpush(logKey, logEntry);
  await redis.ltrim(logKey, -200, -1);
}
