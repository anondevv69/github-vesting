/**
 * Determines whether a GitHub push event contains a real, meaningful code change
 * that should count toward the vesting milestone.
 *
 * Anti-gaming rules:
 *  - Must target the main/production branch (main, master, production, prod).
 *  - Must add or modify ≥ MIN_LINES_CHANGED lines across real code files.
 *  - Markdown-only, lock-file-only, and empty merge commits are rejected.
 *  - Force-pushes reset the daily cooldown but do NOT count as a milestone push.
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
  sender?: { login?: string };
};

export type VerifyResult =
  | { accepted: true; reason: string; linesEstimate: number }
  | { accepted: false; reason: string; linesEstimate?: number; codeFiles?: number };

function branchFromRef(ref: string): string {
  return ref.replace("refs/heads/", "");
}

function isMeaningfulFile(path: string): boolean {
  return !IGNORED_PATTERNS.some((p) => p.test(path));
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
  options?: { bypassCooldown?: boolean; platform?: "github" | "gitlawb" },
): Promise<VerifyResult> {
  const branch = branchFromRef(payload.ref);

  // 1. Must target a production branch.
  if (!PRODUCTION_BRANCHES.has(branch)) {
    return { accepted: false, reason: `Branch "${branch}" is not a production branch` };
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
  const linesEstimate = estimateLines(payload.commits);
  const isGitlawb = options?.platform === "gitlawb";
  if (!isGitlawb && linesEstimate < MIN_LINES_CHANGED) {
    return {
      accepted: false,
      reason: `Estimated ${linesEstimate} lines changed (minimum ${MIN_LINES_CHANGED})`,
    };
  }

  // 5. Reject duplicate head commits (same push redelivered or amended re-count).
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
  if (dailyCount >= MAX_PUSHES_PER_DAY) {
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

export async function recordVerifiedPush(
  repoId: string,
  payload: PushPayload,
  verifyResult: Extract<VerifyResult, { accepted: true }>,
): Promise<number> {
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
  });

  await redis.sadd(seenKey, headSha);
  await redis.incr(dailyKey);
  await redis.expire(dailyKey, 60 * 60 * 48); // expire in 48h
  await redis.rpush(logKey, logEntry);
  await redis.ltrim(logKey, -200, -1); // keep last 200 push logs

  const newTotal = await redis.incr(pushCountKey);
  return newTotal;
}

/** Log a rejected push attempt so the status page shows why it did not count. */
export async function recordRejectedPush(
  repoId: string,
  payload: PushPayload,
  verifyResult: Extract<VerifyResult, { accepted: false }>,
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
  });
  const redis = getRedis();
  const logKey = KEYS.pushLog(repoId);
  await redis.rpush(logKey, logEntry);
  await redis.ltrim(logKey, -200, -1);
}
