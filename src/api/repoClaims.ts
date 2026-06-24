/**
 * Repo ownership claims API.
 *
 * POST /api/repo-claims/challenge
 * POST /api/repo-claims/prepare-file
 * GET  /api/repo-claims/status
 * GET  /api/repo-claims/:owner/:repo
 */

import type { Request, Response } from "express";
import { env } from "../lib/env";
import { isValidWallet } from "../lib/grantsHelper";
import {
  buildClaimFile,
  createClaimChallenge,
  getClaimChallenge,
  getRepoClaim,
} from "../lib/repoClaims";
import { tryVerifyClaimFromGithub } from "../github/repoClaimHandler";
import { normalizeRepoFullName } from "../lib/repoId";

function resolveWallet(req: Request): string | null {
  const raw = String(
    req.headers["x-wallet-address"] ?? req.body?.wallet ?? req.query["wallet"] ?? "",
  ).trim();
  return isValidWallet(raw) ? raw.toLowerCase() : null;
}

function lockUrl(repoFullName: string): string {
  const [owner, name] = repoFullName.split("/");
  return `${env.FRONTEND_URL}/lock/${owner}/${name}`;
}

export async function handleRepoClaimChallenge(req: Request, res: Response): Promise<void> {
  const wallet = resolveWallet(req);
  const repo = String(req.body?.repo ?? req.body?.repoFullName ?? req.query["repo"] ?? "").trim();

  if (!wallet) {
    res.status(400).json({ ok: false, error: "wallet required (x-wallet-address or body)" });
    return;
  }
  if (!repo.includes("/")) {
    res.status(400).json({ ok: false, error: "repo required (owner/name)" });
    return;
  }

  try {
    const challenge = await createClaimChallenge(wallet, repo);
    const fileTemplate = buildClaimFile(
      challenge.claimId,
      challenge.repoFullName,
      challenge.wallet,
      "0x_YOUR_SIGNATURE_HERE",
    );

    const replyText =
      `Repo claim started for ${challenge.repoFullName}\n` +
      `1. Sign the message with wallet ${challenge.wallet}\n` +
      `2. Push ${challenge.filePath} to main with your signature\n` +
      `3. Poll GET /api/repo-claims/status?repo=${challenge.repoFullName}`;

    res.json({
      ok: true,
      ...challenge,
      fileTemplate,
      instructions: [
        "Sign signMessage with your wallet (personal_sign)",
        "POST /api/repo-claims/prepare-file with { claimId, signature }",
        `Push the returned fileContent to ${challenge.filePath} on main`,
        "Install GitHub App on repo if webhook has not verified yet",
      ],
      statusUrl: `${env.SERVER_URL}/api/repo-claims/status?repo=${encodeURIComponent(challenge.repoFullName)}&wallet=${wallet}`,
      replyText,
      tweetReply: replyText,
    });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create challenge",
    });
  }
}

export async function handleRepoClaimPrepareFile(req: Request, res: Response): Promise<void> {
  const claimId = String(req.body?.claimId ?? req.query["claimId"] ?? "").trim();
  const signature = String(req.body?.signature ?? req.query["signature"] ?? "").trim();

  if (!claimId || !signature.startsWith("0x")) {
    res.status(400).json({ ok: false, error: "claimId and signature (0x…) required" });
    return;
  }

  const challenge = await getClaimChallenge(claimId);
  if (!challenge) {
    res.status(404).json({ ok: false, error: "claimId expired or not found" });
    return;
  }

  const fileContent = buildClaimFile(
    challenge.claimId,
    challenge.repoFullName,
    challenge.wallet,
    signature,
  );

  res.json({
    ok: true,
    claimId: challenge.claimId,
    repo: challenge.repoFullName,
    filePath: challenge.filePath,
    fileContent,
    commitMessage: `Proof of Dev: verify repo ownership (${challenge.claimId})`,
    pushInstructions:
      `Add ${challenge.filePath} with the fileContent JSON and push to main. ` +
      `This push does not count toward vesting milestones.`,
  });
}

export async function handleRepoClaimStatus(req: Request, res: Response): Promise<void> {
  const repo = String(req.query["repo"] ?? req.query["repoFullName"] ?? "").trim();
  const wallet = String(req.query["wallet"] ?? "").trim().toLowerCase();
  const poll = req.query["poll"] === "1" || req.query["poll"] === "true";

  if (!repo.includes("/")) {
    res.status(400).json({ ok: false, error: "repo query required (owner/name)" });
    return;
  }

  const normalizedRepo = normalizeRepoFullName(repo);
  let claim = await getRepoClaim(normalizedRepo);

  if (poll && claim?.status !== "verified") {
    claim = (await tryVerifyClaimFromGithub(normalizedRepo)) ?? claim;
  }

  if (!claim) {
    res.json({ ok: true, repo: normalizedRepo, status: "none", verified: false });
    return;
  }

  const walletMatch = !wallet || claim.wallet === wallet;
  const verified = claim.status === "verified" && walletMatch;

  const replyText = verified
    ? `Repo verified — ${normalizedRepo}\n@${claim.githubLogin} ↔ ${claim.wallet}\n\n${lockUrl(normalizedRepo)}`
    : claim.status === "pending"
      ? `Claim pending for ${normalizedRepo} — push .proofofdev/claim.json to main`
      : `No verified claim for ${normalizedRepo}`;

  res.json({
    ok: true,
    repo: normalizedRepo,
    claim,
    status: claim.status,
    verified,
    walletMatch,
    lockUrl: lockUrl(normalizedRepo),
    replyText,
    tweetReply: replyText,
  });
}

export async function handleRepoClaimGet(req: Request, res: Response): Promise<void> {
  const owner = String(req.params["owner"] ?? "");
  const repoName = String(req.params["repoName"] ?? "");
  if (!owner || !repoName) {
    res.status(400).json({ ok: false, error: "owner and repo name required" });
    return;
  }

  req.query["repo"] = `${owner}/${repoName}`;
  await handleRepoClaimStatus(req, res);
}
