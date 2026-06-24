/**
 * POST /api/vesting/register
 *
 * Activates vesting after on-chain lock + platform hook (GitHub App or GitLawb webhook).
 */

import type { Request, Response } from "express";
import { createPublicClient, http, parseAbi, parseEventLogs, type Hash } from "viem";
import { base, baseSepolia } from "viem/chains";
import { saveGrant, getGrant, type GrantRecord } from "../lib/redis";
import { validateRepoAccess, resolveInstallationForRepo } from "../github/githubApp";
import { getRedis, KEYS } from "../lib/redis";
import {
  normalizeRepo,
  repoIdFromPlatform,
  splitRepo,
  type RepoPlatform,
} from "../lib/repoId";
import { verifyGitlawbRepoExists, fetchGitlawbRepo } from "../gitlawb/client";
import { addLinkedWallet } from "../lib/devWallets";
import { env } from "../lib/env";

const ESCROW_ABI = parseAbi([
  "event Locked(bytes32 indexed repoId, address indexed recipient, address indexed token, uint256 amount, uint256 totalPushesRequired, uint256 releasesPerMilestone, uint256 tokensPerMilestone)",
]);

async function repoIdFromLockTx(
  txHash: string,
  chain: "base" | "base-sepolia",
): Promise<string | null> {
  if (!env.GIT_ESCROW_ADDRESS) return null;
  try {
    const viemChain = chain === "base" ? base : baseSepolia;
    const rpc = chain === "base" ? env.BASE_RPC_URL : env.BASE_SEPOLIA_RPC_URL;
    const client = createPublicClient({ chain: viemChain, transport: http(rpc) });
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hash });
    const logs = parseEventLogs({ abi: ESCROW_ABI, logs: receipt.logs, eventName: "Locked" });
    const repoId = logs[0]?.args?.repoId;
    return repoId ? repoId.slice(2) : null;
  } catch (err) {
    console.warn("[register] Could not read Locked event from tx:", err);
    return null;
  }
}

export async function handleRegister(req: Request, res: Response): Promise<void> {
  const body = req.body as Partial<
    GrantRecord & { repoFullName: string; platform?: RepoPlatform }
  >;

  const platform: RepoPlatform = body.platform === "gitlawb" ? "gitlawb" : "github";
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
    streaming,
    gitlawbOwnerDid,
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
    !onChainTxHash
  ) {
    res.status(400).json({ ok: false, error: "Missing required fields" });
    return;
  }

  if (!["base", "base-sepolia"].includes(chain)) {
    res.status(400).json({ ok: false, error: "chain must be base or base-sepolia" });
    return;
  }

  const normalizedRepo = normalizeRepo(repoFullName, platform);
  const onChainRepoId = await repoIdFromLockTx(onChainTxHash, chain as "base" | "base-sepolia");
  const repoId = onChainRepoId ?? repoIdFromPlatform(platform, repoFullName);
  const existing = await getGrant(repoId);
  if (existing && existing.status === "active") {
    res.status(409).json({ ok: false, error: "Active vesting grant already exists for this repo" });
    return;
  }

  let githubInstallId = Number(installationId ?? 0);

  if (platform === "github") {
    const [owner, repoName] = splitRepo(normalizedRepo, "github");
    let installId = githubInstallId;

    const resolved = await resolveInstallationForRepo(owner, repoName);
    if (resolved) {
      installId = resolved;
    } else if (!installId) {
      res.status(400).json({
        ok: false,
        error: "No GitHub App installation found for this repo",
        repo: normalizedRepo,
        hint: "Install the GitHub App and select this repository during setup.",
      });
      return;
    }

    const access = await validateRepoAccess(installId, owner, repoName);
    if (!access.valid) {
      res.status(400).json({
        ok: false,
        error: "GitHub App cannot access this repo — check installation",
        repo: normalizedRepo,
        installationId: installId,
        detail: access.error,
        installedRepos: access.installedRepos?.slice(0, 30),
        hint:
          access.installedRepos?.length &&
          !access.installedRepos.some((r) => r.toLowerCase() === normalizedRepo.toLowerCase())
            ? `Installation ${installId} does not include ${normalizedRepo}. Re-install the app and add this repo, or use one of: ${access.installedRepos.slice(0, 5).join(", ")}`
            : "Confirm the GitHub App is installed on this repo (not just your account).",
      });
      return;
    }
    githubInstallId = installId;
  } else {
    const exists = await verifyGitlawbRepoExists(normalizedRepo);
    if (!exists) {
      res.status(400).json({
        ok: false,
        error: "GitLawb repo not found on node — create it with `gl repo create` first",
        nodeUrl: "https://node.gitlawb.com",
      });
      return;
    }
  }

  const redis = getRedis();
  await redis.set(KEYS.pushCount(repoId), "0");

  let ownerDid = gitlawbOwnerDid;
  if (platform === "gitlawb" && !ownerDid) {
    const [owner, name] = splitRepo(normalizedRepo, "gitlawb");
    const info = await fetchGitlawbRepo(owner, name);
    ownerDid = info?.ownerDid;
  }

  const now = new Date().toISOString();
  const grant: GrantRecord = {
    repoId,
    repoFullName: normalizedRepo,
    platform,
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
    installationId: platform === "github" ? githubInstallId : Number(installationId ?? 0),
    gitlawbOwnerDid: ownerDid,
    status: "active",
    streaming: Boolean(streaming),
    createdAt: now,
    updatedAt: now,
  };

  await saveGrant(grant);
  console.log(`[register] New ${platform} vesting grant for ${normalizedRepo} by ${recipient}`);

  if (platform === "github") {
    const [owner] = splitRepo(normalizedRepo, "github");
    void addLinkedWallet(owner, recipient, "lock").catch(() => {});
  }

  const [owner, repoName] = splitRepo(normalizedRepo, platform);
  const lockPath = `/lock/${owner}/${repoName}`;

  res.json({
    ok: true,
    repoId,
    grant,
    lockPath,
    lockUrl: `${env.FRONTEND_URL}${lockPath}`,
  });
}
