/**
 * POST /api/vesting/register
 *
 * Called after a fee recipient has:
 *   1. Connected GitHub OAuth (we know their GitHub login)
 *   2. Approved + locked tokens in GitEscrow on-chain
 *   3. Installed our GitHub App on their repo
 *
 * Body:
 *   repoFullName   string   "owner/repo"
 *   recipient      string   EVM wallet address (fee recipient)
 *   token          string   ERC-20 contract address
 *   chain          "base" | "base-sepolia"
 *   totalLocked    string   Amount locked (in token's smallest unit, as string)
 *   totalPushesRequired  number
 *   pushesPerMilestone   number
 *   tokensPerMilestone   string
 *   onChainTxHash  string   The lock() transaction hash
 *   installationId number   GitHub App installation ID
 */

import type { Request, Response } from "express";
import { saveGrant, getGrant, type GrantRecord } from "../lib/redis";
import { validateRepoAccess } from "../github/githubApp";
import { getRedis, KEYS } from "../lib/redis";

export async function handleRegister(req: Request, res: Response): Promise<void> {
  const body = req.body as Partial<GrantRecord & { repoFullName: string }>;

  const {
    repoFullName,
    recipient,
    token,
    chain,
    totalLocked,
    totalPushesRequired,
    pushesPerMilestone,
    tokensPerMilestone,
    onChainTxHash,
    installationId,
  } = body;

  if (
    !repoFullName ||
    !recipient ||
    !token ||
    !chain ||
    !totalLocked ||
    !totalPushesRequired ||
    !pushesPerMilestone ||
    !tokensPerMilestone ||
    !onChainTxHash ||
    !installationId
  ) {
    res.status(400).json({ ok: false, error: "Missing required fields" });
    return;
  }

  if (!["base", "base-sepolia"].includes(chain)) {
    res.status(400).json({ ok: false, error: "chain must be base or base-sepolia" });
    return;
  }

  const repoId = Buffer.from(repoFullName).toString("hex");
  const existing = await getGrant(repoId);
  if (existing && existing.status === "active") {
    res.status(409).json({ ok: false, error: "Active vesting grant already exists for this repo" });
    return;
  }

  // Validate GitHub App has access to the repo.
  const access = await validateRepoAccess(Number(installationId), ...splitRepo(repoFullName));
  if (!access.valid) {
    res.status(400).json({ ok: false, error: "GitHub App cannot access this repo — check installation" });
    return;
  }

  // Initialise push counter.
  const redis = getRedis();
  await redis.set(KEYS.pushCount(repoId), "0");

  const now = new Date().toISOString();
  const grant: GrantRecord = {
    repoId,
    repoFullName,
    recipient,
    token,
    chain: chain as GrantRecord["chain"],
    totalLocked,
    totalPushesRequired: Number(totalPushesRequired),
    pushesPerMilestone: Number(pushesPerMilestone),
    tokensPerMilestone,
    verifiedPushCount: 0,
    lastPaidMilestone: 0,
    onChainTxHash,
    installationId: Number(installationId),
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  await saveGrant(grant);
  console.log(`[register] New vesting grant for ${repoFullName} by ${recipient}`);

  res.json({ ok: true, repoId, grant });
}

function splitRepo(full: string): [string, string] {
  const [owner, repo] = full.split("/");
  if (!owner || !repo) throw new Error(`Invalid repoFullName: ${full}`);
  return [owner, repo];
}
