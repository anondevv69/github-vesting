/**
 * POST /api/admin/backfill-pushes
 * Body: { repoFullName: "owner/repo", sinceLockTx?: boolean, recover?: boolean }
 * Header: x-admin-secret
 */

import type { Request, Response } from "express";
import { createPublicClient, http, type Hash } from "viem";
import { env } from "../lib/env";
import { getGrantByRepoFullName } from "../lib/redis";
import { getGithubApp } from "../github/githubApp";
import { splitRepo } from "../lib/repoId";
import { getVestingChainConfig } from "../lib/chains";
import { processPushForGrant } from "../github/processPush";
import { isClaimOnlyPush } from "../lib/repoClaims";
import type { PushPayload } from "../github/pushVerifier";

async function lockTimestamp(grant: {
  onChainTxHash: string;
  chain: "base" | "base-sepolia" | "robinhood";
}): Promise<number> {
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
    pusher: { name: "admin-backfill" },
  };
}

export async function handleAdminBackfillPushes(req: Request, res: Response): Promise<void> {
  const secret = env.ADMIN_SECRET.trim();
  if (!secret) {
    res.status(503).json({ ok: false, error: "ADMIN_SECRET not configured" });
    return;
  }

  const provided = String(req.headers["x-admin-secret"] ?? "").trim();
  if (provided !== secret) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const body = req.body as { repoFullName?: string; sinceLockTx?: boolean; recover?: boolean };
  const repoFullName = String(body.repoFullName ?? "").trim();
  if (!repoFullName.includes("/")) {
    res.status(400).json({ ok: false, error: "repoFullName required (owner/repo)" });
    return;
  }

  const grant = await getGrantByRepoFullName(repoFullName);
  if (!grant || grant.status !== "active") {
    res.status(404).json({ ok: false, error: "No active grant for this repo" });
    return;
  }

  const [owner, repo] = splitRepo(grant.repoFullName, "github");
  const app = getGithubApp();
  const octokit = await app.getInstallationOctokit(grant.installationId);
  const repoInfo = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
  const branch = repoInfo.data.default_branch ?? "main";

  let sinceMs = 0;
  if (body.sinceLockTx !== false) {
    sinceMs = await lockTimestamp(grant);
  }

  const options = body.recover
    ? { bypassCooldown: true, bypassDailyCap: true }
    : undefined;

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

  const results: Array<{ sha: string; accepted: boolean; reason: string; verifiedPushCount?: number }> = [];
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
    if (isClaimOnlyPush(payload.commits)) continue;

    const result = await processPushForGrant(grant, payload, options);
    results.push({
      sha: c.sha,
      accepted: result.accepted,
      reason: result.reason,
      verifiedPushCount: result.verifiedPushCount,
    });
    if (result.accepted && result.verifiedPushCount !== undefined) {
      grant.verifiedPushCount = result.verifiedPushCount;
    }
  }

  const accepted = results.filter((r) => r.accepted).length;
  res.json({
    ok: true,
    repoFullName,
    branch,
    sinceLockTx: sinceMs ? new Date(sinceMs).toISOString() : null,
    evaluated: results.length,
    accepted,
    rejected: results.length - accepted,
    verifiedPushCount: grant.verifiedPushCount,
    results,
  });
}
