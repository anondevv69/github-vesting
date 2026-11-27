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
  /** Multi-lock (design §4.2): a V3 grant's record, keyed by its
   *  on-chain grantId. Legacy (V1/V2) grants keep living under
   *  `grant(repoId)`; a repo may carry one legacy grant PLUS up to
   *  10 V3 grants. */
  grantById: (grantId: string) => `vesting:grant_by_id:${grantId.toLowerCase()}`,
  /** Multi-lock: the set of V3 grantIds created for a repo. */
  repoGrants: (repoId: string) => `vesting:repo_grants:${repoId}`,
  /** Multi-lock: every V3 grantId ever saved (listAllGrants union). */
  allGrantIds: () => `vesting:all_grant_ids`,
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
  /** Launch onboarding (2026-11-26): the platform's record that a
   *  project's FeeLockVault was deployed and its fee grant registered
   *  (POST /api/launch/onboard). Keyed by repo + launcher wallet; the
   *  record is what makes onboarding idempotent and resumable — a
   *  retry after a failed grant registration finds the deployed vault
   *  here and registers against it instead of deploying a second one.
   *  No TTL: onboarding is a permanent platform fact for the project. */
  launchOnboarding: (repoFullName: string, wallet: string) =>
    `vesting:launch_onboarding:${repoFullName.toLowerCase()}:${wallet.toLowerCase()}`,
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
  /** Count-attestation nonce counter (Codex round-4): INCR'd per
   *  issued oracle CountAttestation for a repo; the escrow enforces
   *  a strictly-increasing nonce per repo, so every issued nonce is
   *  unique and a consumed attestation can never be replayed. */
  countAttestationNonce: (repoId: string) => `vesting:count_attestation_nonce:${repoId}`,
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
  /** Reviewer swarm (mandatory-window rule, 2026-11-26): a push that
   *  passed the verifier and is inside its 6h review window, stored
   *  with everything the settlement path needs to count it later
   *  (quorum or window expiry) without a webhook redelivery. */
  swarmPendingPush: (repoFullName: string, headSha: string) =>
    `vesting:swarm_pending:${repoFullName.toLowerCase()}:${headSha.toLowerCase()}`,
  /** Index of pending swarm pushes ("repo|sha" members) for the settler. */
  swarmPendingIndex: () => `vesting:swarm_pending_index`,
};

export type LaunchOnboardingStatus =
  | "deployment_started"
  | "vault_deploying"
  | "vault_deployed"
  | "deployment_failed"
  | "grant_registered";

export type LaunchOnboardingRecord = {
  repo: string;
  wallet: string;
  chain: string;
  chainId: number;
  repoId: string;
  githubLogin: string;
  feeLockVault: string;
  feePushesPerTranche: number;
  status: LaunchOnboardingStatus;
  /** Operator nonce the vault's CREATE address was predicted from
   *  (deployment_started records only) — lets a later retry tell a
   *  never-broadcast deployment from an in-flight one. */
  operatorNonce?: number;
  deployTxHash?: string;
  registerTxHash?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export async function getLaunchOnboarding(
  repoFullName: string,
  wallet: string,
): Promise<LaunchOnboardingRecord | null> {
  const raw = await getRedis().get(KEYS.launchOnboarding(repoFullName, wallet));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LaunchOnboardingRecord;
  } catch {
    return null;
  }
}

export async function saveLaunchOnboarding(record: LaunchOnboardingRecord): Promise<void> {
  await getRedis().set(
    KEYS.launchOnboarding(record.repo, record.wallet),
    JSON.stringify({ ...record, updatedAt: new Date().toISOString() }),
  );
}

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
  /** The escrow contract this grant was created under — the contract
   *  that emitted the Locked event in `onChainTxHash`, recorded at
   *  registration (v1→v2 cutover, 2026-11-26). The release path
   *  services the grant through THIS escrow (see
   *  resolveGrantEscrowAddress in src/lib/chains.ts). Unset on grants
   *  registered before per-grant recording existed: those resolve to
   *  the chain's legacy escrow. */
  escrowAddress?: string;
  /** Multi-lock (design §4.2): the on-chain grantId (bytes32 hex).
   *  V3 grants only — V1/V2 grants predate grantIds. */
  grantId?: string;
  /** Multi-lock: repo cumulative counted total stamped on-chain at
   *  lock time (GitEscrowV3 knownPushCount). This grant vests only
   *  on pushes counted after it. V3 grants only. */
  startPushCount?: number;
  /** Multi-lock: escrow generation this grant was created under,
   *  derived from escrowAddress identity at registration
   *  (see escrowVersionOf in src/lib/chains.ts). */
  escrowVersion?: 1 | 2 | 3;
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
  /** Reviewer swarm: LEGACY opt-in flag — IGNORED since 2026-11-26.
   *  Gregory's adopted rule makes swarm review mandatory for every
   *  grant (verifier first, then a 6h review window with a verifier
   *  fallback — see src/lib/swarmReview.ts). Retained on the record
   *  only so grants stored before the rule change still parse; the
   *  counting path never reads it. */
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

export async function saveGrantById(grant: GrantRecord): Promise<void> {
  if (!grant.grantId) throw new Error("saveGrantById: grant.grantId required");
  const redis = getRedis();
  const platform = grant.platform ?? "github";
  const normalized: GrantRecord = {
    ...grant,
    platform,
    grantId: grant.grantId.toLowerCase(),
    totalLocked: normalizeWeiString(grant.totalLocked),
    tokensPerMilestone: normalizeWeiString(grant.tokensPerMilestone),
  };
  await redis.set(KEYS.grantById(normalized.grantId!), JSON.stringify(normalized));
  await redis.sadd(KEYS.repoGrants(normalized.repoId), normalized.grantId!);
  await redis.sadd(KEYS.allGrantIds(), normalized.grantId!);
  await redis.sadd(KEYS.allGrants(), normalized.repoId);
  await redis.set(KEYS.repoByName(platform, normalized.repoFullName), normalized.repoId);
}

export async function getGrantById(grantId: string): Promise<GrantRecord | null> {
  const raw = await getRedis().get(KEYS.grantById(grantId));
  if (!raw) return null;
  const grant = JSON.parse(raw) as GrantRecord;
  if (!grant.platform) grant.platform = "github";
  grant.totalLocked = normalizeWeiString(grant.totalLocked);
  grant.tokensPerMilestone = normalizeWeiString(grant.tokensPerMilestone);
  return grant;
}

export async function updateGrantById(
  grantId: string,
  patch: Partial<GrantRecord>,
): Promise<void> {
  const existing = await getGrantById(grantId);
  if (!existing) throw new Error(`Grant not found: ${grantId}`);
  await saveGrantById({ ...existing, ...patch, updatedAt: new Date().toISOString() });
}

/** All grants for a repo (design §4.2): the legacy V1/V2 grant
 *  first (under vesting:grant:{repoId}) when present, then the
 *  repo's V3 grants in creation order. */
export async function listGrantsForRepo(repoId: string): Promise<GrantRecord[]> {
  const redis = getRedis();
  const out: GrantRecord[] = [];
  const legacy = await getGrant(repoId);
  if (legacy) out.push(legacy);
  const ids = await redis.smembers(KEYS.repoGrants(repoId));
  const v3: GrantRecord[] = [];
  for (const id of ids) {
    const g = await getGrantById(id);
    if (g) v3.push(g);
  }
  v3.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return [...out, ...v3];
}

/** The primary grant (design §4.5): the earliest-created ACTIVE
 *  grant; if none is active, the most recently created grant. For
 *  every pre-multi-lock repo this returns exactly the grant the
 *  1:1 resolution returned before. */
export function pickPrimaryGrant(grants: GrantRecord[]): GrantRecord | null {
  if (grants.length === 0) return null;
  const byCreation = [...grants].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
  const active = byCreation.filter((g) => g.status === "active");
  if (active.length > 0) return active[0]!;
  return byCreation[byCreation.length - 1]!;
}

async function resolveRepoIdByName(
  repoFullName: string,
  platform?: RepoPlatform,
): Promise<string | null> {
  const redis = getRedis();
  if (platform) {
    return redis.get(KEYS.repoByName(platform, repoFullName));
  }
  for (const p of ["github", "gitlawb"] as RepoPlatform[]) {
    const repoId = await redis.get(KEYS.repoByName(p, repoFullName));
    if (repoId) return repoId;
  }
  // Legacy grants (pre-platform prefix)
  return redis.get(`vesting:repo_name:${repoFullName.toLowerCase()}`);
}

export async function getGrantByRepoFullName(
  repoFullName: string,
  platform?: RepoPlatform,
): Promise<GrantRecord | null> {
  const repoId = await resolveRepoIdByName(repoFullName, platform);
  if (!repoId) return null;
  const grants = await listGrantsForRepo(repoId);
  if (grants.length > 0) return pickPrimaryGrant(grants);
  return getGrant(repoId);
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
  const repoIds = await redis.smembers(KEYS.allGrants());
  const legacy = await Promise.all(repoIds.map((id) => getGrant(id)));
  const out = legacy.filter((g): g is GrantRecord => g !== null);
  const grantIds = await redis.smembers(KEYS.allGrantIds());
  const seen = new Set(out.map((g) => g.grantId?.toLowerCase()).filter(Boolean));
  for (const id of grantIds) {
    if (seen.has(id.toLowerCase())) continue;
    const g = await getGrantById(id);
    if (g) out.push(g);
  }
  return out;
}

export async function deleteGrantByRepoFullName(
  repoFullName: string,
  platform?: RepoPlatform,
): Promise<GrantRecord | null> {
  const grant = await getGrantByRepoFullName(repoFullName, platform);
  if (!grant) return null;

  const redis = getRedis();
  const plat = grant.platform ?? "github";
  const v3Ids = await redis.smembers(KEYS.repoGrants(grant.repoId));
  for (const id of v3Ids) {
    await redis.del(KEYS.grantById(id));
    await redis.srem(KEYS.allGrantIds(), id);
  }
  await redis.del(KEYS.repoGrants(grant.repoId));
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
