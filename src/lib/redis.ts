import Redis from "ioredis";
import { env } from "./env";

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
};

import type { RepoPlatform } from "./repoId";

export type GrantRecord = {
  repoId: string;
  repoFullName: string;
  platform: RepoPlatform;
  recipient: string;
  token: string;
  chain: "base" | "base-sepolia";
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

export async function saveGrant(grant: GrantRecord): Promise<void> {
  const redis = getRedis();
  const platform = grant.platform ?? "github";
  await redis.set(KEYS.grant(grant.repoId), JSON.stringify({ ...grant, platform }));
  await redis.sadd(KEYS.allGrants(), grant.repoId);
  await redis.set(KEYS.repoByName(platform, grant.repoFullName), grant.repoId);
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
