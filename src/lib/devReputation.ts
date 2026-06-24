/**
 * Developer reputation — earned through vesting commitment, verified pushes, and community ratings.
 */

import { getRedis, KEYS, type GrantRecord } from "./redis";
import { formatTokenAmount } from "./grantsHelper";
import { parseWei } from "./wei";
import type { DevReview } from "../api/explore";

export type DevBadge = {
  id: string;
  label: string;
  description: string;
  icon: string;
};

export type DevReputation = {
  level: number;
  title: string;
  score: number;
  nextLevelScore: number;
  stats: {
    totalVerifiedPushes: number;
    totalTokensLockedWei: string;
    totalTokensLockedFormatted: string;
    activeLocks: number;
    completedLocks: number;
    totalRepos: number;
    milestonesPaid: number;
    avgRating: number | null;
    reviewCount: number;
    firstLockAt: string | null;
    lastPushAt: string | null;
  };
  scoreBreakdown: {
    shipping: number;
    commitment: number;
    community: number;
  };
  badges: DevBadge[];
  earnedBadgeIds: string[];
};

const LEVELS: Array<{ min: number; title: string }> = [
  { min: 0, title: "Newcomer" },
  { min: 12, title: "Shipper" },
  { min: 28, title: "Builder" },
  { min: 48, title: "Committed Dev" },
  { min: 68, title: "Product Champion" },
  { min: 85, title: "Elite Builder" },
];

const BADGE_DEFS: Record<string, Omit<DevBadge, "id">> = {
  "first-lock": {
    label: "First Lock",
    description: "Started a GitHub vesting lock",
    icon: "🔒",
  },
  "verified-shipper": {
    label: "Verified Shipper",
    description: "10+ verified pushes on main",
    icon: "🚀",
  },
  "prolific-shipper": {
    label: "Prolific Shipper",
    description: "50+ verified pushes across repos",
    icon: "⚡",
  },
  "whale-commit": {
    label: "Whale Commit",
    description: "10M+ tokens locked in vesting",
    icon: "🐋",
  },
  "vesting-complete": {
    label: "Vesting Complete",
    description: "Finished at least one vesting schedule",
    icon: "✅",
  },
  "multi-repo": {
    label: "Multi-Repo",
    description: "Vesting locks on 2+ repositories",
    icon: "📦",
  },
  "still-shipping": {
    label: "Still Shipping",
    description: "Active lock with verified pushes on record",
    icon: "🔥",
  },
  "community-trusted": {
    label: "Community Trusted",
    description: "4.5+ average from 3+ community reviews",
    icon: "⭐",
  },
  "community-loved": {
    label: "Community Loved",
    description: "4.8+ average from 5+ community reviews",
    icon: "💜",
  },
  "milestone-maker": {
    label: "Milestone Maker",
    description: "Paid 3+ on-chain vesting releases",
    icon: "🏆",
  },
};

function badge(id: string): DevBadge {
  const def = BADGE_DEFS[id]!;
  return { id, ...def };
}

function levelFromScore(score: number): { level: number; title: string; nextLevelScore: number } {
  let level = 1;
  let title = LEVELS[0]!.title;
  let nextLevelScore = LEVELS[1]?.min ?? 100;

  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (score >= LEVELS[i]!.min) {
      level = i + 1;
      title = LEVELS[i]!.title;
      nextLevelScore = LEVELS[i + 1]?.min ?? 100;
      break;
    }
  }

  return { level, title, nextLevelScore };
}

function shippingPoints(pushes: number): number {
  return Math.min(40, Math.round(pushes * 2));
}

function commitmentPoints(totalLockedWei: bigint): number {
  const tokens = Number(totalLockedWei) / 1e18;
  if (tokens <= 0) return 0;
  const pts = Math.log10(Math.max(tokens, 1)) * 7;
  return Math.min(35, Math.round(pts));
}

function communityPoints(avgRating: number | null, reviewCount: number): number {
  if (!avgRating || reviewCount === 0) return 0;
  const quality = (avgRating / 5) * 15;
  const volume = Math.min(10, reviewCount * 2);
  return Math.min(25, Math.round(quality + volume));
}

async function lastPushTimestamp(grants: GrantRecord[]): Promise<string | null> {
  const redis = getRedis();
  let latest: number | null = null;

  for (const grant of grants) {
    const raw = await redis.lrange(KEYS.pushLog(grant.repoId), -1, -1);
    if (raw.length === 0) continue;
    try {
      const entry = JSON.parse(raw[0]!) as { ts?: number };
      if (entry.ts && (latest === null || entry.ts > latest)) latest = entry.ts;
    } catch { /* ignore */ }
  }

  return latest ? new Date(latest).toISOString() : null;
}

function computeBadges(
  grants: GrantRecord[],
  stats: DevReputation["stats"],
  totalLockedWei: bigint,
): DevBadge[] {
  const ids: string[] = [];

  if (grants.length > 0) ids.push("first-lock");
  if (stats.totalVerifiedPushes >= 10) ids.push("verified-shipper");
  if (stats.totalVerifiedPushes >= 50) ids.push("prolific-shipper");
  if (totalLockedWei >= 10_000_000n * 10n ** 18n) ids.push("whale-commit");
  if (stats.completedLocks >= 1) ids.push("vesting-complete");
  if (stats.totalRepos >= 2) ids.push("multi-repo");
  if (stats.activeLocks >= 1 && stats.totalVerifiedPushes > 0) ids.push("still-shipping");
  if (stats.milestonesPaid >= 3) ids.push("milestone-maker");
  if (stats.avgRating !== null && stats.avgRating >= 4.5 && stats.reviewCount >= 3) {
    ids.push("community-trusted");
  }
  if (stats.avgRating !== null && stats.avgRating >= 4.8 && stats.reviewCount >= 5) {
    ids.push("community-loved");
  }

  return ids.map(badge);
}

export async function computeDevReputation(
  grants: GrantRecord[],
  reviews: DevReview[],
): Promise<DevReputation> {
  const totalVerifiedPushes = grants.reduce((s, g) => s + g.verifiedPushCount, 0);
  const totalLockedWei = grants.reduce((s, g) => s + parseWei(g.totalLocked), 0n);
  const activeLocks = grants.filter((g) => g.status === "active").length;
  const completedLocks = grants.filter((g) => g.status === "complete").length;
  const milestonesPaid = grants.reduce((s, g) => s + g.lastPaidMilestone, 0);
  const avgRating = reviews.length
    ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
    : null;

  const firstLockAt = grants.length
    ? grants.reduce(
        (earliest, g) => (g.createdAt < earliest ? g.createdAt : earliest),
        grants[0]!.createdAt,
      )
    : null;

  const lastPushAt = await lastPushTimestamp(grants);

  const stats: DevReputation["stats"] = {
    totalVerifiedPushes,
    totalTokensLockedWei: totalLockedWei.toString(),
    totalTokensLockedFormatted: formatTokenAmount(totalLockedWei.toString()),
    activeLocks,
    completedLocks,
    totalRepos: grants.length,
    milestonesPaid,
    avgRating,
    reviewCount: reviews.length,
    firstLockAt,
    lastPushAt,
  };

  const scoreBreakdown = {
    shipping: shippingPoints(totalVerifiedPushes),
    commitment: commitmentPoints(totalLockedWei),
    community: communityPoints(avgRating, reviews.length),
  };

  const score = scoreBreakdown.shipping + scoreBreakdown.commitment + scoreBreakdown.community;
  const { level, title, nextLevelScore } = levelFromScore(score);
  const badges = computeBadges(grants, stats, totalLockedWei);

  return {
    level,
    title,
    score,
    nextLevelScore,
    stats,
    scoreBreakdown,
    badges,
    earnedBadgeIds: badges.map((b) => b.id),
  };
}

export async function computeLeaderboard(
  allGrants: GrantRecord[],
  limit = 20,
): Promise<Array<{ githubLogin: string; reputation: DevReputation }>> {
  const byDev = new Map<string, GrantRecord[]>();

  for (const grant of allGrants) {
    const owner = grant.repoFullName.split("/")[0]?.toLowerCase();
    if (!owner) continue;
    const devKey = grant.platform === "gitlawb" ? `gl:${owner}` : owner;
    const list = byDev.get(devKey) ?? [];
    list.push(grant);
    byDev.set(devKey, list);
  }

  const redis = getRedis();
  const entries = await Promise.all(
    [...byDev.entries()].map(async ([githubLogin, grants]) => {
      const reviewsRaw = await redis.lrange(KEYS.devReviews(githubLogin), 0, -1);
      const reviews = reviewsRaw
        .map((r) => { try { return JSON.parse(r) as DevReview; } catch { return null; } })
        .filter((r): r is DevReview => r !== null);

      const reputation = await computeDevReputation(grants, reviews);
      return { githubLogin, reputation };
    }),
  );

  return entries
    .sort((a, b) => b.reputation.score - a.reputation.score)
    .slice(0, limit);
}
