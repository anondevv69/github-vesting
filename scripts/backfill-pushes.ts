#!/usr/bin/env npx tsx
/**
 * Replay GitHub commits as verified pushes when webhooks were missed (e.g. grant not in Redis).
 *
 * Usage:
 *   npx tsx scripts/backfill-pushes.ts --repo anondevv69/RH-Wallet [--since-lock-tx] [--recover]
 *
 * --since-lock-tx  Only commits after the grant's on-chain lock block time
 * --recover        Bypass daily cap + cooldown (use when missed pushes were a platform bug)
 */

import * as dotenv from "dotenv";
dotenv.config();

import { createPublicClient, http, type Hash } from "viem";
import { getGrantByRepoFullName } from "../src/lib/redis";
import { getGithubApp } from "../src/github/githubApp";
import { splitRepo } from "../src/lib/repoId";
import { getVestingChainConfig } from "../src/lib/chains";
import { processPushForGrant } from "../src/github/processPush";
import { isClaimOnlyPush } from "../src/lib/repoClaims";
import type { PushPayload } from "../src/github/pushVerifier";

async function lockTimestamp(grant: { onChainTxHash: string; chain: "base" | "base-sepolia" | "robinhood" }) {
  const cfg = getVestingChainConfig(grant.chain);
  const client = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
  const receipt = await client.getTransactionReceipt({ hash: grant.onChainTxHash as Hash });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  return Number(block.timestamp) * 1000;
}

function commitToPayload(
  repoFullName: string,
  branch: string,
  sha: string,
  message: string,
  files: Array<{ filename: string; status: string }>,
  authorDate: string,
): PushPayload {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const f of files) {
    if (f.status === "added") added.push(f.filename);
    else if (f.status === "removed") removed.push(f.filename);
    else modified.push(f.filename);
  }
  return {
    ref: `refs/heads/${branch}`,
    forced: false,
    after: sha,
    commits: [{ id: sha, message, added, removed, modified, timestamp: authorDate }],
    repository: { full_name: repoFullName },
    pusher: { name: "backfill" },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const getFlag = (name: string) => args.includes(name);
  const getArg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const repoFullName = getArg("--repo");
  if (!repoFullName) {
    console.error("Usage: --repo owner/name [--since-lock-tx] [--recover]");
    process.exit(1);
  }

  const grant = await getGrantByRepoFullName(repoFullName);
  if (!grant || grant.status !== "active") {
    console.error("No active grant for", repoFullName);
    process.exit(1);
  }

  const [owner, repo] = splitRepo(grant.repoFullName, "github");
  const app = getGithubApp();
  const octokit = await app.getInstallationOctokit(grant.installationId);
  const repoInfo = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
  const branch = repoInfo.data.default_branch ?? "main";

  let sinceMs = 0;
  if (getFlag("--since-lock-tx")) {
    sinceMs = await lockTimestamp(grant);
    console.log(`Lock time: ${new Date(sinceMs).toISOString()}`);
  }

  const recover = getFlag("--recover");
  const options = recover ? { bypassCooldown: true, bypassDailyCap: true } : undefined;

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
      const date = c.commit.author?.date ?? c.commit.committer?.date ?? "";
      if (sinceMs && date && Date.parse(date) < sinceMs) continue;
      commits.push({ sha: c.sha, date, message: c.commit.message });
    }
    if (data.length < 100) break;
    page++;
  }

  commits.reverse();
  console.log(`Evaluating ${commits.length} commit(s) on ${branch}…`);

  let accepted = 0;
  let rejected = 0;
  for (const c of commits) {
    const detail = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner,
      repo,
      ref: c.sha,
    });
    const files = (detail.data.files ?? []).map((f) => ({
      filename: f.filename,
      status: f.status ?? "modified",
    }));
    const payload = commitToPayload(grant.repoFullName, branch, c.sha, c.message, files, c.date);
    if (isClaimOnlyPush(payload.commits)) {
      console.log(`  skip ${c.sha.slice(0, 7)} claim-only`);
      continue;
    }
    const result = await processPushForGrant(grant, payload, options);
    if (result.accepted) {
      accepted++;
      grant.verifiedPushCount = result.verifiedPushCount ?? grant.verifiedPushCount;
      console.log(`  ✓ ${c.sha.slice(0, 7)} → ${result.verifiedPushCount} (${result.reason})`);
    } else {
      rejected++;
      console.log(`  ✗ ${c.sha.slice(0, 7)} — ${result.reason}`);
    }
  }

  console.log(`Done: ${accepted} accepted, ${rejected} rejected, total=${grant.verifiedPushCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
