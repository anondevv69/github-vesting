/**
 * Public discovery: explore grants, lookup by token, dev profiles, reviews.
 */

import type { Request, Response } from "express";
import { listAllGrants, getRedis, KEYS, type GrantRecord } from "../lib/redis";
import { buildProgress, formatTokenAmount, isValidWallet } from "../lib/grantsHelper";
import { computeDevReputation, computeLeaderboard } from "../lib/devReputation";
import { splitRepo } from "../lib/repoId";

export type DevReview = {
  wallet: string;
  rating: number;
  comment: string;
  createdAt: string;
};

function grantSummary(grant: GrantRecord) {
  const progress = buildProgress(grant);
  const [owner] = splitRepo(grant.repoFullName, grant.platform ?? "github");
  return {
    repoFullName: grant.repoFullName,
    githubOwner: owner,
    platform: grant.platform ?? "github",
    recipient: grant.recipient,
    token: grant.token,
    chain: grant.chain,
    status: grant.status,
    streaming: grant.streaming,
    totalLocked: grant.totalLocked,
    totalLockedFormatted: formatTokenAmount(grant.totalLocked),
    progress,
    createdAt: grant.createdAt,
  };
}

function dedupeGrants(grants: GrantRecord[]): GrantRecord[] {
  const byRepo = new Map<string, GrantRecord>();
  for (const g of grants) {
    const prev = byRepo.get(g.repoFullName);
    if (!prev || g.updatedAt > prev.updatedAt) byRepo.set(g.repoFullName, g);
  }
  return [...byRepo.values()];
}

export async function handleExplore(_req: Request, res: Response): Promise<void> {
  const grants = dedupeGrants(await listAllGrants());
  res.json({
    ok: true,
    count: grants.length,
    grants: grants.map(grantSummary).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
}

export async function handleByToken(req: Request, res: Response): Promise<void> {
  const token = String(req.query["token"] ?? req.params["token"] ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(token)) {
    res.status(400).json({ ok: false, error: "token address required (0x…)" });
    return;
  }

  const grants = dedupeGrants(await listAllGrants()).filter(
    (g) => g.token.toLowerCase() === token,
  );

  res.json({
    ok: true,
    token,
    count: grants.length,
    grants: grants.map(grantSummary),
  });
}

export async function handleByDev(req: Request, res: Response): Promise<void> {
  const login = String(req.query["github"] ?? req.params["login"] ?? "").trim().toLowerCase();
  if (!login) {
    res.status(400).json({ ok: false, error: "github login required" });
    return;
  }

  try {
    const grants = dedupeGrants(await listAllGrants()).filter((g) => {
      try {
        const [owner] = splitRepo(g.repoFullName, g.platform ?? "github");
        return owner.toLowerCase() === login;
      } catch {
        return false;
      }
    });

    const redis = getRedis();
    const reviewsRaw = await redis.lrange(KEYS.devReviews(login), 0, -1);
    const reviews = reviewsRaw
      .map((r) => { try { return JSON.parse(r) as DevReview; } catch { return null; } })
      .filter((r): r is DevReview => r !== null)
      .reverse();

    const avgRating = reviews.length
      ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
      : null;

    const reputation = await computeDevReputation(grants, reviews);

    res.json({
      ok: true,
      githubLogin: login,
      grantCount: grants.length,
      grants: grants.map(grantSummary),
      reviews,
      avgRating,
      reputation,
      communityUrl: grants[0]?.token
        ? `https://www.bankr.space/community/${grants[0].token}`
        : null,
    });
  } catch (err) {
    console.error("[by-dev]", login, err);
    res.status(500).json({ ok: false, error: "Failed to load dev profile" });
  }
}

export async function handlePostDevReview(req: Request, res: Response): Promise<void> {
  const login = String(req.params["login"] ?? "").trim().toLowerCase();
  const wallet = String(req.body?.wallet ?? req.headers["x-wallet-address"] ?? "").trim().toLowerCase();
  const rating = Number(req.body?.rating);
  const comment = String(req.body?.comment ?? "").trim().slice(0, 500);

  if (!login) {
    res.status(400).json({ ok: false, error: "github login required" });
    return;
  }
  if (!isValidWallet(wallet)) {
    res.status(400).json({ ok: false, error: "wallet required (0x…)" });
    return;
  }
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    res.status(400).json({ ok: false, error: "rating must be 1–5" });
    return;
  }
  if (comment.length < 3) {
    res.status(400).json({ ok: false, error: "comment too short" });
    return;
  }

  const review: DevReview = {
    wallet,
    rating,
    comment,
    createdAt: new Date().toISOString(),
  };

  const redis = getRedis();
  await redis.rpush(KEYS.devReviews(login), JSON.stringify(review));
  await redis.ltrim(KEYS.devReviews(login), -100, -1);

  res.json({ ok: true, review });
}

export async function handleLeaderboard(req: Request, res: Response): Promise<void> {
  const limit = Math.min(Number(req.query["limit"] ?? 20), 50);
  const grants = dedupeGrants(await listAllGrants());
  const leaderboard = await computeLeaderboard(grants, limit);

  res.json({
    ok: true,
    count: leaderboard.length,
    leaderboard,
  });
}
