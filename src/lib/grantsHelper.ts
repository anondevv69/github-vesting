import { listAllGrants, getGrantByRepoFullName, getRedis, KEYS, type GrantRecord } from "./redis";
import { parseWei } from "./wei";

export function buildProgress(grant: GrantRecord) {
  const totalMilestones = Math.floor(grant.totalPushesRequired / grant.pushesPerMilestone);
  const nextMilestoneAt = (grant.lastPaidMilestone + 1) * grant.pushesPerMilestone;
  const progressPct = grant.totalPushesRequired > 0
    ? Math.floor((grant.verifiedPushCount / grant.totalPushesRequired) * 100)
    : 0;
  const isComplete = grant.status === "complete" || grant.verifiedPushCount >= grant.totalPushesRequired;
  const singleRelease = totalMilestones === 1;

  return {
    verifiedPushCount: grant.verifiedPushCount,
    totalPushesRequired: grant.totalPushesRequired,
    progressPct,
    nextMilestoneAt: isComplete ? null : nextMilestoneAt,
    milestonesCompleted: grant.lastPaidMilestone,
    totalMilestones,
    pushesUntilNextRelease: isComplete
      ? 0
      : Math.max(0, nextMilestoneAt - grant.verifiedPushCount),
    singleRelease,
    releaseEvery: grant.pushesPerMilestone,
    summary: singleRelease
      ? `${grant.totalPushesRequired} verified push${grant.totalPushesRequired === 1 ? "" : "es"} on main → all tokens release in one payout`
      : `${grant.pushesPerMilestone} verified pushes per release · ${totalMilestones} payouts total`,
  };
}

export function formatTokenAmount(wei: string | number | bigint): string {
  const w = parseWei(wei);
  const n = Number(w / 10n ** 15n) / 1e3;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export async function fetchGrantsForRecipient(recipient: string) {
  const grants = (await listAllGrants()).filter(
    (g) => g.recipient.toLowerCase() === recipient.toLowerCase(),
  );

  const byRepo = new Map<string, GrantRecord>();
  for (const g of grants) {
    const prev = byRepo.get(g.repoFullName);
    if (!prev || g.updatedAt > prev.updatedAt) byRepo.set(g.repoFullName, g);
  }

  const redis = getRedis();
  return Promise.all(
    [...byRepo.values()].map(async (grant) => ({
      grant,
      progress: buildProgress(grant),
      recentPushes: (await redis.lrange(KEYS.pushLog(grant.repoId), -5, -1))
        .map((entry) => {
          try { return JSON.parse(entry) as Record<string, unknown>; } catch { return { raw: entry }; }
        })
        .reverse(),
    })),
  );
}

export async function fetchGrantStatus(repoFullName: string) {
  const grant = await getGrantByRepoFullName(repoFullName);
  if (!grant) return null;

  const redis = getRedis();
  const pushLog = await redis.lrange(KEYS.pushLog(grant.repoId), -20, -1);
  const recentPushes = pushLog.map((entry) => {
    try { return JSON.parse(entry); } catch { return entry; }
  });

  return {
    grant,
    progress: buildProgress(grant),
    recentPushes,
  };
}

export function isValidWallet(address: string): boolean {
  return /^0x[a-f0-9]{40}$/i.test(address);
}
