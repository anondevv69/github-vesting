#!/usr/bin/env npx tsx
/**
 * Replay missed GitHub pushes to production via signed webhooks.
 * Usage: npx tsx scripts/replay-pushes-prod.ts --repo anondevv69/RH-Wallet [--since-lock-tx]
 */

import * as dotenv from "dotenv";
dotenv.config();

import { createHmac } from "crypto";
import { createPublicClient, http, type Hash } from "viem";
import { getGithubApp } from "../src/github/githubApp";
import { splitRepo } from "../src/lib/repoId";
import { getVestingChainConfig } from "../src/lib/chains";
import { isClaimOnlyPush } from "../src/lib/repoClaims";

const API = process.env.REPLAY_API_URL?.trim() || "https://api.proofofdev.xyz";

async function lockTimestamp(grant: {
  onChainTxHash: string;
  chain: "base" | "base-sepolia" | "robinhood";
}) {
  const cfg = getVestingChainConfig(grant.chain);
  const client = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
  const receipt = await client.getTransactionReceipt({ hash: grant.onChainTxHash as Hash });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  return Number(block.timestamp) * 1000;
}

async function sendPush(payload: object) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET required");
  const body = Buffer.from(JSON.stringify(payload));
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const res = await fetch(`${API}/api/webhook/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": sig,
    },
    body,
  });
  return { status: res.status, body: await res.text() };
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const repoFullName = getArg("--repo");
  const sinceLock = args.includes("--since-lock-tx");
  if (!repoFullName) {
    console.error("Usage: --repo owner/name [--since-lock-tx]");
    process.exit(1);
  }

  const [owner, repo] = splitRepo(repoFullName, "github");
  const lockRes = await fetch(`${API}/api/vesting/lock/${owner}/${repo}`);
  if (!lockRes.ok) {
    console.error("No grant on API for", repoFullName);
    process.exit(1);
  }
  const lockData = (await lockRes.json()) as {
    grant: { installationId: number; onChainTxHash: string; chain: "base" | "base-sepolia" | "robinhood" };
  };
  const grant = lockData.grant;
  const installationId = grant.installationId;

  const app = getGithubApp();
  const octokit = await app.getInstallationOctokit(installationId);
  const repoInfo = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
  const branch = repoInfo.data.default_branch ?? "main";

  let sinceMs = 0;
  if (sinceLock) sinceMs = await lockTimestamp(grant);

  const commits: Array<{ sha: string; date: string; message: string }> = [];
  let page = 1;
  for (;;) {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/commits", {
      owner,
      repo,
      sha: branch,
      per_page: 100,
      page,
    });
    if (data.length === 0) break;
    for (const c of data) {
      const date = c.commit.author?.date ?? "";
      if (sinceMs && date && Date.parse(date) < sinceMs) continue;
      commits.push({ sha: c.sha, date, message: c.commit.message });
    }
    if (data.length < 100) break;
    page++;
  }
  commits.reverse();

  for (const c of commits) {
    const detail = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner,
      repo,
      ref: c.sha,
    });
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    for (const f of detail.data.files ?? []) {
      if (f.status === "added") added.push(f.filename);
      else if (f.status === "removed") removed.push(f.filename);
      else modified.push(f.filename);
    }
    const commitObj = {
      id: c.sha,
      message: c.message,
      added,
      removed,
      modified,
      timestamp: c.date,
    };
    if (isClaimOnlyPush([commitObj])) {
      console.log(`skip ${c.sha.slice(0, 7)} claim-only`);
      continue;
    }
    const payload = {
      ref: `refs/heads/${branch}`,
      forced: false,
      after: c.sha,
      commits: [commitObj],
      repository: { full_name: repoFullName },
      pusher: { name: "replay" },
    };
    const result = await sendPush(payload);
    console.log(c.sha.slice(0, 7), result.status, result.body.slice(0, 120));
    await new Promise((r) => setTimeout(r, 500));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
