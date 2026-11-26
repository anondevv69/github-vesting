import Redis from "ioredis";
import { env } from "./env";
import { normalizeWeiString } from "./wei";

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      connectTimeout: 10_000,
    });
    _redis.on("error", (err) => console.error("[redis]", err));
  }
  return _redis;
}

// ─── Keys ────────────────────────────────────────────────────────────────────

export const KEYS = {
  grant: (repoId: string) => `vesting:grant:${repoId}`,
  pushCount: (repoId: string) => `vesting:pushes:${repoId}`,
  pushLog: (repoId: string) => `vesting:push_log:${repoId}`,
  dailyCount: (repoId: string, dateStr: string) => `vesting:daily:${repoId}:${dateStr}`,
  oauthState: (state: string) => `vesting:oauth:${state}`,
  installation: (installationId: number) => `vesting:install:${installationId}`,
  allGrants: () => `vesting:all_grants`,
  repoByName: (platform: string, repoFullName: string) =>
    `vesting:repo_name:${platform}:${repoFullName.toLowerCase()}`,
  seenPushShas: (repoId: string) => `vesting:seen_shas:${repoId}`,
  devReviews: (githubLogin: string) => `vesting:dev_reviews:${githubLogin.toLowerCase()}`,
  devProfile: (githubLogin: string) => `vesting:dev_profile:${githubLogin.toLowerCase()}`,
  devLinkedWallets: (githubLogin: string) => `vesting:dev_wallets:${githubLogin.toLowerCase()}`,
  devPendingRewards: (githubLogin: string) => `vesting:dev_pending_rewards:${githubLogin.toLowerCase()}`,
  devWalletLinkChallenge: (id: string) => `vesting:dev_wallet_link:${id}`,
  githubMagicLink: (token: string) => `vesting:github_magic_link:${token.toLowerCase()}`,
  repoClaim: (repoFullName: string) => `vesting:repo_claim:${repoFullName.toLowerCase()}`,
  repoClaimChallenge: (claimId: string) => `vesting:repo_claim_challenge:${claimId}`,
  githubSession: (sessionId: string) => `vesting:github_session:${sessionId}`,
  shipReport: (repoFullName: string, headSha: string) =>
    `vesting:ship_report:${repoFullName.toLowerCase()}:${headSha.toLowerCase()}`,
  shipReportsByRepo: (repoFullName: string) =>
    `vesting:ship_reports:${repoFullName.toLowerCase()}`,
  /** Settlement evidence (tx hashes) for one counted push, recorded at
   *  webhook/settle time so late-filed ship reports can reconstruct `paid`. */
  shipSettlement: (repoFullName: string, headSha: string) =>
    `vesting:ship_settlement:${repoFullName.toLowerCase()}:${headSha.toLowerCase()}`,
  /** Repo full names that have had grant-less pushes processed (feed index). */
  grantlessRepos: () => `vesting:grantless_repos`,
  /** Launch-gate: one issued verification token, keyed by its nonce (TTL = token TTL). */
  launchVerifyNonce: (nonce: string) => `vesting:launch_verify_nonce:${nonce}`,
  /** Launch-gate: latest verification record for a repo+wallet (recognition rule). */
  launchVerificationRecord: (repoFullName: string, wallet: string) =>
    `vesting:launch_verified:${repoFullName.toLowerCase()}:${wallet.toLowerCase()}`,
  /** Launch-gate: ShipRewards enrolment for a VERIFIED launcher (dual
   *  reward, spec §8B) — written at grant registration when a valid
   *  verification token was presented; no TTL, eligibility persists. */
  launcherRewardEnrollment: (repoFullName: string, wallet: string) =>
    `vesting:launcher_reward_enrollment:${repoFullName.toLowerCase()}:${wallet.toLowerCase()}`,
  /** Launch recognition (Codex round-2): the prepared-launch record
   *  written by POST /api/launch/prepare-launch — the prepared fee
   *  recipients + the fee-lock vault's codehash pinned at prepare
   *  time. Registration compares the actual launch against this. */
  preparedLaunch: (repoFullName: string, wallet: string) =>
    `vesting:prepared_launch:${repoFullName.toLowerCase()}:${wallet.toLowerCase()}`,
  /** Recount checkpoint (Codex round-2): the counted-state snapshot
   *  written after every counted push, so a recount can start from a
   *  proven prefix when the push log has been trimmed past it. */
  pushCheckpoint: (repoId: string) => `vesting:push_checkpoint:${repoId}`,
  /** Fee-release retry (Codex round-2): a durable record that a
   *  counted push's fee-tranche release failed after the supply
   *  release succeeded; retried on the next counted push and by the
   *  keeper sweep. */
  pendingFeeRelease: (repoId: string) => `vesting:pending_fee_release:${repoId}`,
  pendingFeeReleaseIndex: () => `vesting:pending_fee_release_index`,
  /** Reviewer swarm: enrolment record per reviewer GitHub login. */
  swarmReviewer: (githubLogin: string) => `vesting:swarm_reviewer:${githubLogin.toLowerCase()}`,
  /** Reviewer swarm: review attestations for one push (repo + head SHA). */
  swarmReviews: (repoFullName: string, headSha: string) =>
    `vesting:swarm_reviews:${repoFullName.toLowerCase()}:${headSha.toLowerCase()}`,
  /** Reviewer swarm: server-side candidate record for one push. */
  swarmPush: (repoFullName: string, headSha: string) =>
    `vesting:swarm_push:${repoFullName.toLowerCase()}:${headSha.toLowerCase()}`,
  /** Reviewer swarm: candidate head SHAs per repo (review queue index). */
  swarmCandidates: (repoFullName: string) =>
    `vesting:swarm_candidates:${repoFullName.toLowerCase()}`,
  /** Reviewer swarm: uniqueness ledger — counted diff fingerprint → the
   *  head SHA that counted it, per repo. No TTL: uniqueness is forever. */
  swarmCountedFingerprints: (repoFullName: string) =>
    `vesting:swarm_counted_fps:${repoFullName.toLowerCase()}`,
};

import type { RepoPlatform } from "./repoId";

export type GrantRecord = {
  repoId: string;
  repoFullName: string;
  platform: RepoPlatform;
  recipient: string;
  token: string;
  chain: "base" | "base-sepolia" | "robinhood";
  totalLocked: string;
  totalPushesRequired: number;
  pushesPerMilestone: number;
  tokensPerMilestone: string;
  verifiedPushCount: number;
  lastPaidMilestone: number;
  onChainTxHash: string;
  installationId: number;
  /** Launch gate: true when grant registration carried a valid GitHub App
   *  verification token (see src/lib/launchGate.ts). Grants registered
   *  through the legacy web flow have this unset/false and are NOT
   *  SDK-launch grants — they get no launch recognition. */
  launchVerified?: boolean;
  /** GitHub login that passed launch verification for this grant. */
  launchVerifiedLogin?: string;
  /** Dual reward (§8B): true when this grant's launcher is a verified
   *  launcher enrolled for ShipRewards per-counted-merge payments on
   *  this repo, on top of the grant's own milestone unlocks. */
  launcherRewardEnrolled?: boolean;
  /** Reviewer swarm: when true, pushes on this grant count only after
   *  the independent-reviewer quorum gate passes (see
   *  src/lib/swarmReview.ts). Opt-in per grant; default OFF (unset) so
   *  existing grants keep the pre-swarm behaviour exactly. */
  swarmReviewRequired?: boolean;
  /** Fee-lock (Gregory's decided launcher rule, 2026-11-25): the
   *  project's FeeLockVault address — the claim-capable fee recipient
   *  named on the launch. When set, counted pushes also run the
   *  fee-tranche release step (src/oracle/feeLock.ts) against the
   *  chain's FeeStreamEscrow. Recorded at verified-launch registration. */
  feeLockVault?: string;
  /** Fee-stream schedule: counted pushes over which each fee tranche
   *  vests (mirrors the on-chain FeeStreamEscrow registration). */
  feePushesPerTranche?: number;
  /** GitLawb owner DID (full did:key:…) when platform is gitlawb */
  gitlawbOwnerDid?: string;
  status: "active" | "complete" | "cancelled";
  /// true = streaming-allowance (tokens stay in recipient's wallet)
  /// false = pre-funded (tokens are held in the escrow contract)
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RepoClaimRecord = {
  claimId: string;
  repoFullName: string;
  wallet: string;
  githubLogin: string;
  status: "pending" | "verified";
  commitSha?: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export async function saveGrant(grant: GrantRecord): Promise<void> {
  const redis = getRedis();
  const platform = grant.platform ?? "github";
  const normalized: GrantRecord = {
    ...grant,
    platform,
    totalLocked: normalizeWeiString(grant.totalLocked),
    tokensPerMilestone: normalizeWeiString(grant.tokensPerMilestone),
  };
  await redis.set(KEYS.grant(normalized.repoId), JSON.stringify(normalized));
  await redis.sadd(KEYS.allGrants(), normalized.repoId);
  await redis.set(KEYS.repoByName(platform, normalized.repoFullName), normalized.repoId);
}

export async function getGrantByRepoFullName(
  repoFullName: string,
  platform?: RepoPlatform,
): Promise<GrantRecord | null> {
  const redis = getRedis();

  if (platform) {
    const repoId = await redis.get(KEYS.repoByName(platform, repoFullName));
    if (!repoId) return null;
    return getGrant(repoId);
  }

  for (const p of ["github", "gitlawb"] as RepoPlatform[]) {
    const repoId = await redis.get(KEYS.repoByName(p, repoFullName));
    if (repoId) return getGrant(repoId);
  }

  // Legacy grants (pre-platform prefix)
  const legacyId = await redis.get(`vesting:repo_name:${repoFullName.toLowerCase()}`);
  if (legacyId) return getGrant(legacyId);

  return null;
}

export async function getGrant(repoId: string): Promise<GrantRecord | null> {
  const raw = await getRedis().get(KEYS.grant(repoId));
  if (!raw) return null;
  const grant = JSON.parse(raw) as GrantRecord;
  if (!grant.platform) grant.platform = "github";
  grant.totalLocked = normalizeWeiString(grant.totalLocked);
  grant.tokensPerMilestone = normalizeWeiString(grant.tokensPerMilestone);
  return grant;
}

export async function updateGrant(repoId: string, patch: Partial<GrantRecord>): Promise<void> {
  const existing = await getGrant(repoId);
  if (!existing) throw new Error(`Grant not found: ${repoId}`);
  await saveGrant({ ...existing, ...patch, updatedAt: new Date().toISOString() });
}

export async function listAllGrants(): Promise<GrantRecord[]> {
  const redis = getRedis();
  const ids = await redis.smembers(KEYS.allGrants());
  const grants = await Promise.all(ids.map((id) => getGrant(id)));
  return grants.filter((g): g is GrantRecord => g !== null);
}

export async function deleteGrantByRepoFullName(
  repoFullName: string,
  platform?: RepoPlatform,
): Promise<GrantRecord | null> {
  const grant = await getGrantByRepoFullName(repoFullName, platform);
  if (!grant) return null;

  const redis = getRedis();
  const plat = grant.platform ?? "github";
  await redis.del(KEYS.grant(grant.repoId));
  await redis.srem(KEYS.allGrants(), grant.repoId);
  await redis.del(KEYS.repoByName(plat, grant.repoFullName));
  await redis.del(`vesting:repo_name:${grant.repoFullName.toLowerCase()}`);
  await redis.del(KEYS.pushCount(grant.repoId));
  await redis.del(KEYS.pushLog(grant.repoId));
  await redis.del(KEYS.seenPushShas(grant.repoId));
  await redis.del(KEYS.pushCheckpoint(grant.repoId));
  await redis.del(KEYS.pendingFeeRelease(grant.repoId));
  await redis.srem(KEYS.pendingFeeReleaseIndex(), grant.repoId);

  return grant;
}
