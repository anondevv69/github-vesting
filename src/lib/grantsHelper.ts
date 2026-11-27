import { listAllGrants, getGrantByRepoFullName, listGrantsForRepo, getRedis, KEYS, type GrantRecord } from "./redis";
import { parseWei } from "./wei";

/** Grant-relative counted pushes (design §4.5): for a V3 grant, the
 *  repo cumulative total minus the grant's on-chain baseline; for a
 *  legacy grant, the record's own count (its basis, as today). */
export function grantRelativeCount(grant: GrantRecord, repoTotal: number): number {
  if (grant.escrowVersion === 3) {
    return Math.max(0, repoTotal - (grant.startPushCount ?? 0));
  }
  return grant.verifiedPushCount;
}

/**
 * Progress for one grant. `grantRelativeVerifiedCount` is the
 * grant-relative counted-push total (design §4.5): V3 callers pass
 * `repoTotal - startPushCount`; legacy callers omit it and the
 * record's own count is used, exactly as before multi-lock.
 */
export function buildProgress(grant: GrantRecord, grantRelativeVerifiedCount?: number) {
  const verifiedPushCount = grantRelativeVerifiedCount ?? grant.verifiedPushCount;
  const totalMilestones = Math.floor(grant.totalPushesRequired / grant.pushesPerMilestone);
  const nextMilestoneAt = (grant.lastPaidMilestone + 1) * grant.pushesPerMilestone;
  const progressPct = grant.totalPushesRequired > 0
    ? Math.floor((verifiedPushCount / grant.totalPushesRequired) * 100)
    : 0;
  const isComplete = grant.status === "complete" || verifiedPushCount >= grant.totalPushesRequired;
  const singleRelease = totalMilestones === 1;

  return {
    verifiedPushCount,
    totalPushesRequired: grant.totalPushesRequired,
    progressPct,
    nextMilestoneAt: isComplete ? null : nextMilestoneAt,
    milestonesCompleted: grant.lastPaidMilestone,
    totalMilestones,
    pushesUntilNextRelease: isComplete
      ? 0
      : Math.max(0, nextMilestoneAt - verifiedPushCount),
    singleRelease,
    releaseEvery: grant.pushesPerMilestone,
    summary: singleRelease
      ? `${grant.totalPushesRequired} verified push${grant.totalPushesRequired === 1 ? "" : "es"} on main → all tokens release in one payout`
      : `${grant.pushesPerMilestone} verified pushes per release · ${totalMilestones} payouts total`,
  };
}

/** Per-grant status entry (design §4.5), shared by the status and
 *  lock-detail endpoints. */
export async function buildGrantEntries(repoId: string, grants: GrantRecord[]) {
  const redis = getRedis();
  const rawTotal = await redis.get(KEYS.pushCount(repoId));
  const repoTotal = rawTotal ? parseInt(rawTotal, 10) || 0 : 0;
  return grants.map((g) => {
    const relative = grantRelativeCount(g, repoTotal);
    const progress = buildProgress(g, relative);
    return {
      grantId: g.grantId ?? null,
      escrowVersion: g.escrowVersion ?? null,
      escrowAddress: g.escrowAddress ?? null,
      recipient: g.recipient,
      token: g.token,
      chain: g.chain,
      totalLocked: g.totalLocked,
      totalPushesRequired: g.totalPushesRequired,
      pushesPerMilestone: g.pushesPerMilestone,
      tokensPerMilestone: g.tokensPerMilestone,
      startPushCount: g.startPushCount ?? null,
      verifiedPushCount: relative,
      lastPaidMilestone: g.lastPaidMilestone,
      status: g.status,
      onChainTxHash: g.onChainTxHash,
      ...(g.escrowVersion === 3
        ? {
            nextMilestoneAtRepoTotal:
              g.status === "complete"
                ? null
                : (g.startPushCount ?? 0) + (g.lastPaidMilestone + 1) * g.pushesPerMilestone,
          }
        : {}),
      progress,
    };
  });
}

export async function repoPushTotal(repoId: string): Promise<number> {
  const raw = await getRedis().get(KEYS.pushCount(repoId));
  return raw ? parseInt(raw, 10) || 0 : 0;
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

  const byKey = new Map<string, GrantRecord>();
  for (const g of grants) {
    const key = g.grantId ?? g.repoFullName;
    const prev = byKey.get(key);
    if (!prev || g.updatedAt > prev.updatedAt) byKey.set(key, g);
  }

  const redis = getRedis();
  return Promise.all(
    [...byKey.values()].map(async (grant) => ({
      grant,
      progress: buildProgress(grant, grantRelativeCount(grant, await repoPushTotal(grant.repoId))),
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

  const grants = await listGrantsForRepo(grant.repoId);
  const repoTotal = await repoPushTotal(grant.repoId);

  return {
    grant,
    progress: buildProgress(grant, grantRelativeCount(grant, repoTotal)),
    grants: await buildGrantEntries(grant.repoId, grants),
    recentPushes,
  };
}

export function isValidWallet(address: string): boolean {
  return /^0x[a-f0-9]{40}$/i.test(address);
}
