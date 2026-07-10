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
  devWalletLinkChallenge: (id: string) => `vesting:dev_wallet_link:${id}`,
  githubMagicLink: (token: string) => `vesting:github_magic_link:${token.toLowerCase()}`,
  repoClaim: (repoFullName: string) => `vesting:repo_claim:${repoFullName.toLowerCase()}`,
  repoClaimChallenge: (claimId: string) => `vesting:repo_claim_challenge:${claimId}`,
  githubSession: (sessionId: string) => `vesting:github_session:${sessionId}`,
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

  return grant;
}
