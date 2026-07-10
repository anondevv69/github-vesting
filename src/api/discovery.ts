/**
 * Unified search, recent activity, and lock detail helpers.
 */

import type { Request, Response } from "express";
import { listAllGrants, getGrantByRepoFullName, getRedis, KEYS, updateGrant, type GrantRecord } from "../lib/redis";
import { buildProgress, formatTokenAmount } from "../lib/grantsHelper";
import { splitRepo } from "../lib/repoId";
import { parseWei } from "../lib/wei";
import { getDevProfile } from "./devProfile";
import { fetchBankrTokenInfo } from "./bankr";
import { getRepoClaim } from "../lib/repoClaims";
import { listLinkedWallets } from "../lib/devWallets";
import { detectChainFromLockTx } from "../lib/detectGrantChain";

function dedupeGrants(grants: GrantRecord[]): GrantRecord[] {
  const byRepo = new Map<string, GrantRecord>();
  for (const g of grants) {
    const prev = byRepo.get(g.repoFullName);
    if (!prev || g.updatedAt > prev.updatedAt) byRepo.set(g.repoFullName, g);
  }
  return [...byRepo.values()];
}

export type SearchResult =
  | { type: "dev"; id: string; label: string; secondary: string; href: string }
  | { type: "repo"; id: string; label: string; secondary: string; href: string }
  | { type: "token"; id: string; label: string; secondary: string; href: string };

function lockPath(repoFullName: string): string {
  const [owner, repo] = repoFullName.split("/");
  return `/lock/${owner}/${repo}`;
}

export async function handleSearch(req: Request, res: Response): Promise<void> {
  const q = String(req.query["q"] ?? "").trim().toLowerCase();
  if (q.length < 1) {
    res.json({ ok: true, results: [] });
    return;
  }

  const grants = dedupeGrants(await listAllGrants());
  const results: SearchResult[] = [];
  const seenDevs = new Set<string>();
  const seenTokens = new Set<string>();
  const seenRepos = new Set<string>();

  for (const g of grants) {
    const [owner] = splitRepo(g.repoFullName, g.platform ?? "github");
    const progress = buildProgress(g);
    const repoKey = g.repoFullName.toLowerCase();

    if (!seenDevs.has(owner) && owner.toLowerCase().includes(q)) {
      seenDevs.add(owner);
      const devGrants = grants.filter((x) =>
        splitRepo(x.repoFullName, x.platform ?? "github")[0].toLowerCase() === owner.toLowerCase(),
      );
      const pushes = devGrants.reduce((s, x) => s + x.verifiedPushCount, 0);
      results.push({
        type: "dev",
        id: owner,
        label: `@${owner}`,
        secondary: `${devGrants.length} lock${devGrants.length === 1 ? "" : "s"} · ${pushes} pushes`,
        href: `/dev/${owner}`,
      });
    }

    if (!seenRepos.has(repoKey) && repoKey.includes(q)) {
      seenRepos.add(repoKey);
      results.push({
        type: "repo",
        id: g.repoFullName,
        label: g.repoFullName,
        secondary: `${formatTokenAmount(g.totalLocked)} · ${progress.verifiedPushCount}/${progress.totalPushesRequired} pushes`,
        href: lockPath(g.repoFullName),
      });
    }

    const token = g.token.toLowerCase();
    if (!seenTokens.has(token) && (token.includes(q) || q.length >= 4 && token.startsWith(q))) {
      seenTokens.add(token);
      const tokenGrants = grants.filter((x) => x.token.toLowerCase() === token);
      const totalLocked = tokenGrants.reduce((s, x) => s + parseWei(x.totalLocked), 0n);
      results.push({
        type: "token",
        id: g.token,
        label: `${g.token.slice(0, 6)}…${g.token.slice(-4)}`,
        secondary: `${tokenGrants.length} lock${tokenGrants.length === 1 ? "" : "s"} · ${formatTokenAmount(totalLocked.toString())}`,
        href: lockPath(tokenGrants[0]!.repoFullName),
      });
    }
  }

  const qBare = q.replace(/^@/, "");
  const ownersChecked = new Set<string>();
  for (const g of grants) {
    const [owner] = splitRepo(g.repoFullName, g.platform ?? "github");
    const ownerKey = owner.toLowerCase();
    if (ownersChecked.has(ownerKey) || seenDevs.has(owner)) continue;
    ownersChecked.add(ownerKey);

    const profile = await getDevProfile(owner);
    if (!profile) continue;

    const twitter = profile.twitter?.toLowerCase() ?? "";
    const displayName = profile.displayName?.toLowerCase() ?? "";
    const matchesTwitter = twitter.length > 0 && (twitter.includes(qBare) || qBare.includes(twitter));
    const matchesName = displayName.length > 0 && displayName.includes(qBare);

    if (matchesTwitter || matchesName) {
      seenDevs.add(owner);
      const devGrants = grants.filter((x) =>
        splitRepo(x.repoFullName, x.platform ?? "github")[0].toLowerCase() === ownerKey,
      );
      const pushes = devGrants.reduce((s, x) => s + x.verifiedPushCount, 0);
      const via = matchesTwitter && twitter ? `@${twitter} on X` : displayName;
      results.push({
        type: "dev",
        id: owner,
        label: `@${owner}`,
        secondary: `${via} · ${devGrants.length} lock${devGrants.length === 1 ? "" : "s"} · ${pushes} pushes`,
        href: `/dev/${owner}`,
      });
    }
  }

  res.json({ ok: true, results: results.slice(0, 20) });
}

export async function handleRecentPushes(req: Request, res: Response): Promise<void> {
  const limit = Math.min(Number(req.query["limit"] ?? 10), 30);
  const grants = dedupeGrants(await listAllGrants());
  const redis = getRedis();

  type PushRow = {
    ts: number;
    repoFullName: string;
    githubOwner: string;
    sha: string;
    linesEstimate?: number;
    commitCount?: number;
  };

  const rows: PushRow[] = [];

  await Promise.all(
    grants.map(async (grant) => {
      const [owner] = splitRepo(grant.repoFullName, grant.platform ?? "github");
      const log = await redis.lrange(KEYS.pushLog(grant.repoId), -10, -1);
      for (const entry of log) {
        try {
          const p = JSON.parse(entry) as {
            ts: number;
            sha: string;
            linesEstimate?: number;
            commitCount?: number;
            accepted?: boolean;
          };
          if (p.accepted === false) continue;
          rows.push({
            ts: p.ts,
            repoFullName: grant.repoFullName,
            githubOwner: owner,
            sha: p.sha,
            linesEstimate: p.linesEstimate,
            commitCount: p.commitCount,
          });
        } catch { /* skip */ }
      }
    }),
  );

  rows.sort((a, b) => b.ts - a.ts);

  res.json({
    ok: true,
    pushes: rows.slice(0, limit).map((p) => ({
      ...p,
      href: lockPath(p.repoFullName),
      devHref: `/dev/${p.githubOwner}`,
    })),
  });
}

export async function handleLockDetail(req: Request, res: Response): Promise<void> {
  const repoParam = String(req.query["repo"] ?? "").trim();
  const owner = String(req.params["owner"] ?? req.query["owner"] ?? "").trim();
  const repoName = String(req.params["repoName"] ?? req.query["repoName"] ?? "").trim();
  const repoFullName = repoParam || (owner && repoName ? `${owner}/${repoName}` : "");

  if (!repoFullName.includes("/")) {
    res.status(400).json({ ok: false, error: "repo required (owner/name)" });
    return;
  }

  const grant = await getGrantByRepoFullName(repoFullName);
  if (!grant) {
    res.status(404).json({ ok: false, error: "No lock found for this repo" });
    return;
  }

  let resolvedGrant = grant;
  const detectedChain = await detectChainFromLockTx(grant.onChainTxHash);
  if (detectedChain && detectedChain !== grant.chain) {
    await updateGrant(grant.repoId, { chain: detectedChain });
    resolvedGrant = { ...grant, chain: detectedChain };
  }

  const redis = getRedis();
  const pushLog = await redis.lrange(KEYS.pushLog(grant.repoId), -50, -1);
  const recentPushes = pushLog
    .map((entry) => {
      try { return JSON.parse(entry); } catch { return null; }
    })
    .filter(Boolean);

  const progress = buildProgress(resolvedGrant);
  const [githubOwner] = splitRepo(resolvedGrant.repoFullName, resolvedGrant.platform ?? "github");

  const releasedWei = parseWei(resolvedGrant.tokensPerMilestone) * BigInt(resolvedGrant.lastPaidMilestone);
  const remainingWei = parseWei(resolvedGrant.totalLocked) - releasedWei;

  const allGrants = dedupeGrants(await listAllGrants());
  const sameToken = allGrants.filter((g) => g.token.toLowerCase() === resolvedGrant.token.toLowerCase());
  const totalTokenLocked = sameToken.reduce((s, g) => s + parseWei(g.totalLocked), 0n);

  const tokenHolders = sameToken.map((g) => {
    const [dev] = splitRepo(g.repoFullName, g.platform ?? "github");
    const amountWei = parseWei(g.totalLocked);
    const pct = totalTokenLocked > 0n
      ? Number((amountWei * 10000n) / totalTokenLocked) / 100
      : 0;
    return {
      wallet: g.recipient,
      dev,
      repoFullName: g.repoFullName,
      amount: g.totalLocked,
      amountFormatted: formatTokenAmount(g.totalLocked),
      pct,
      href: lockPath(g.repoFullName),
      devHref: `/dev/${dev}`,
    };
  }).sort((a, b) => Number(parseWei(b.amount) - parseWei(a.amount)));

  const bankr = await fetchBankrTokenInfo(resolvedGrant.token, resolvedGrant.chain);
  const repoClaim = await getRepoClaim(repoFullName);

  const feeRecipientWallet = bankr?.feeRecipient?.wallet?.toLowerCase();
  let feeRecipientLink: {
    linked: boolean;
    githubLogin: string;
    source?: string;
    linkedAt?: string;
  } | null = null;
  if (feeRecipientWallet) {
    const linkedWallets = await listLinkedWallets(githubOwner);
    const match = linkedWallets.find((w) => w.wallet === feeRecipientWallet);
    feeRecipientLink = {
      linked: Boolean(match),
      githubLogin: githubOwner,
      source: match?.source,
      linkedAt: match?.linkedAt,
    };
  }

  res.json({
    ok: true,
    grant: resolvedGrant,
    progress,
    recentPushes,
    githubOwner,
    repoClaim,
    released: releasedWei.toString(),
    releasedFormatted: formatTokenAmount(releasedWei.toString()),
    remaining: remainingWei.toString(),
    remainingFormatted: formatTokenAmount(remainingWei.toString()),
    tokenHolders,
    totalTokenLocked: totalTokenLocked.toString(),
    totalTokenLockedFormatted: formatTokenAmount(totalTokenLocked.toString()),
    bankr,
    feeRecipientLink,
  });
}
