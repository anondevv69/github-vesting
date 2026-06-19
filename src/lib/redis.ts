import Redis from "ioredis";
import { env } from "./env";

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(env.REDIS_URL, { lazyConnect: false });
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
};

export type GrantRecord = {
  repoId: string;
  repoFullName: string;
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
  status: "active" | "complete" | "cancelled";
  /// true = streaming-allowance (tokens stay in recipient's wallet)
  /// false = pre-funded (tokens are held in the escrow contract)
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
};

export async function saveGrant(grant: GrantRecord): Promise<void> {
  const redis = getRedis();
  await redis.set(KEYS.grant(grant.repoId), JSON.stringify(grant));
  await redis.sadd(KEYS.allGrants(), grant.repoId);
}

export async function getGrant(repoId: string): Promise<GrantRecord | null> {
  const raw = await getRedis().get(KEYS.grant(repoId));
  return raw ? (JSON.parse(raw) as GrantRecord) : null;
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
