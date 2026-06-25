/**
 * Repo ownership claims — bond wallet ↔ GitHub repo via signed push file.
 */

import { randomBytes } from "crypto";
import {
  type Address,
  type Hex,
} from "viem";
import { getRedis, KEYS, type RepoClaimRecord } from "./redis";
import { normalizeRepoFullName } from "./repoId";
import { isValidWallet } from "./grantsHelper";
import { verifyWalletMessage } from "./walletSignature";
import { resolveInstallationForRepo } from "../github/githubApp";
import { getGithubApp } from "../github/githubApp";
import { addLinkedWallet } from "./devWallets";

export const CLAIM_FILE_PATH = ".proofofdev/claim.json";
export const CLAIM_CHALLENGE_TTL_SEC = 60 * 60 * 24; // 24h

export type ClaimFileV1 = {
  v: 1;
  claimId: string;
  repo: string;
  wallet: string;
  signature: string;
};

export type PendingClaimChallenge = {
  claimId: string;
  repoFullName: string;
  wallet: string;
  signMessage: string;
  filePath: string;
  expiresAt: string;
  createdAt: string;
};

function newClaimId(): string {
  return `clm_${randomBytes(12).toString("hex")}`;
}

export function buildSignMessage(claimId: string, repoFullName: string, wallet: string): string {
  return (
    `Proof of Dev — repo claim\n` +
    `Claim: ${claimId}\n` +
    `Repo: ${repoFullName}\n` +
    `Wallet: ${wallet.toLowerCase()}`
  );
}

export function buildClaimFile(
  claimId: string,
  repoFullName: string,
  wallet: string,
  signature: string,
): ClaimFileV1 {
  return {
    v: 1,
    claimId,
    repo: repoFullName,
    wallet: wallet.toLowerCase(),
    signature,
  };
}

export async function createClaimChallenge(
  wallet: string,
  repoInput: string,
): Promise<PendingClaimChallenge> {
  if (!isValidWallet(wallet)) throw new Error("Invalid wallet address");
  const repoFullName = normalizeRepoFullName(repoInput);
  if (!repoFullName.includes("/")) throw new Error("repo must be owner/name");

  const claimId = newClaimId();
  const signMessage = buildSignMessage(claimId, repoFullName, wallet);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CLAIM_CHALLENGE_TTL_SEC * 1000);

  const challenge: PendingClaimChallenge = {
    claimId,
    repoFullName,
    wallet: wallet.toLowerCase(),
    signMessage,
    filePath: CLAIM_FILE_PATH,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  };

  const redis = getRedis();
  await redis.set(
    KEYS.repoClaimChallenge(claimId),
    JSON.stringify(challenge),
    "EX",
    CLAIM_CHALLENGE_TTL_SEC,
  );

  const pending: RepoClaimRecord = {
    claimId,
    repoFullName,
    wallet: wallet.toLowerCase(),
    githubLogin: "",
    status: "pending",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await redis.set(KEYS.repoClaim(repoFullName), JSON.stringify(pending));

  return challenge;
}

export async function getClaimChallenge(claimId: string): Promise<PendingClaimChallenge | null> {
  const raw = await getRedis().get(KEYS.repoClaimChallenge(claimId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingClaimChallenge;
  } catch {
    return null;
  }
}

export async function getRepoClaim(repoFullName: string): Promise<RepoClaimRecord | null> {
  const raw = await getRedis().get(KEYS.repoClaim(normalizeRepoFullName(repoFullName)));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RepoClaimRecord;
  } catch {
    return null;
  }
}

export function parseClaimFileJson(text: string): ClaimFileV1 | null {
  try {
    const data = JSON.parse(text) as Partial<ClaimFileV1>;
    if (data.v !== 1 || !data.claimId || !data.repo || !data.wallet || !data.signature) return null;
    return data as ClaimFileV1;
  } catch {
    return null;
  }
}

export async function verifyClaimFile(
  file: ClaimFileV1,
  repoFullName: string,
): Promise<{ ok: true; wallet: string; claimId: string } | { ok: false; error: string }> {
  const normalizedRepo = normalizeRepoFullName(repoFullName);
  if (normalizeRepoFullName(file.repo) !== normalizedRepo) {
    return { ok: false, error: "claim file repo does not match" };
  }
  if (!isValidWallet(file.wallet)) {
    return { ok: false, error: "invalid wallet in claim file" };
  }

  const challenge = await getClaimChallenge(file.claimId);
  if (!challenge) {
    const existing = await getRepoClaim(normalizedRepo);
    if (existing?.status === "verified" && existing.claimId === file.claimId) {
      return { ok: true, wallet: file.wallet.toLowerCase(), claimId: file.claimId };
    }
    return { ok: false, error: "claimId expired or unknown — request a new challenge" };
  }

  if (challenge.repoFullName !== normalizedRepo) {
    return { ok: false, error: "claimId is for a different repo" };
  }
  if (challenge.wallet !== file.wallet.toLowerCase()) {
    return { ok: false, error: "wallet does not match challenge" };
  }

  const signMessage = buildSignMessage(file.claimId, normalizedRepo, file.wallet);
  const valid = await verifyWalletMessage(
    file.wallet as Address,
    signMessage,
    file.signature as Hex,
  );
  if (!valid) {
    return { ok: false, error: "invalid wallet signature" };
  }

  return { ok: true, wallet: file.wallet.toLowerCase(), claimId: file.claimId };
}

export async function markClaimVerified(
  repoFullName: string,
  wallet: string,
  claimId: string,
  githubLogin: string,
  commitSha: string,
): Promise<RepoClaimRecord> {
  const normalizedRepo = normalizeRepoFullName(repoFullName);
  const now = new Date().toISOString();
  const record: RepoClaimRecord = {
    claimId,
    repoFullName: normalizedRepo,
    wallet: wallet.toLowerCase(),
    githubLogin,
    status: "verified",
    commitSha,
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const existing = await getRepoClaim(normalizedRepo);
  if (existing?.createdAt) record.createdAt = existing.createdAt;

  const redis = getRedis();
  await redis.set(KEYS.repoClaim(normalizedRepo), JSON.stringify(record));
  await redis.del(KEYS.repoClaimChallenge(claimId));
  void addLinkedWallet(githubLogin, wallet, "repo-claim").catch(() => {});
  return record;
}

export async function fetchClaimFileFromGithub(
  repoFullName: string,
): Promise<string | null> {
  const normalized = normalizeRepoFullName(repoFullName);
  const [owner, repo] = normalized.split("/") as [string, string];
  const installId = await resolveInstallationForRepo(owner, repo);

  try {
    if (installId) {
      const app = getGithubApp();
      const octokit = await app.getInstallationOctokit(installId);
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path: CLAIM_FILE_PATH,
      });
      if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
      return Buffer.from(data.content, "base64").toString("utf8");
    }

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(CLAIM_FILE_PATH)}`,
      { headers: { accept: "application/vnd.github+json", "user-agent": "github-vesting" } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: string; encoding?: string };
    if (!data.content) return null;
    return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function pushTouchesClaimFile(
  commits: Array<{ added?: string[]; modified?: string[] }>,
): boolean {
  for (const c of commits) {
    const paths = [...(c.added ?? []), ...(c.modified ?? [])];
    if (paths.some((p) => p === CLAIM_FILE_PATH || p.endsWith("/claim.json"))) return true;
  }
  return false;
}

export function isClaimOnlyPush(
  commits: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>,
): boolean {
  const all = commits.flatMap((c) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]);
  if (all.length === 0) return false;
  return all.every((p) => p === CLAIM_FILE_PATH || p.startsWith(".proofofdev/"));
}
