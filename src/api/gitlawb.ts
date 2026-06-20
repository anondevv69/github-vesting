/**
 * GitLawb integration helpers — repo lookup + webhook setup info.
 *
 * @see https://gitlawb.com/start
 * @see https://gitlawb.com/agents
 */

import type { Request, Response } from "express";
import { env } from "../lib/env";
import { fetchGitlawbRepo } from "../gitlawb/client";
import { normalizeGitlawbRepo, splitRepo } from "../lib/repoId";

export async function handleGitlawbRepoLookup(req: Request, res: Response): Promise<void> {
  const repo = String(req.query["repo"] ?? "").trim();
  if (!repo) {
    res.status(400).json({ ok: false, error: "repo query required (ownerShort/repoName)" });
    return;
  }

  const normalized = normalizeGitlawbRepo(repo);
  const [owner, name] = splitRepo(normalized, "gitlawb");
  const info = await fetchGitlawbRepo(owner, name);

  if (!info) {
    res.status(404).json({ ok: false, error: "Repo not found on GitLawb node", repo: normalized });
    return;
  }

  res.json({
    ok: true,
    repoFullName: normalized,
    platform: "gitlawb",
    repo: info,
    profileUrl: `https://gitlawb.com/${owner.slice(0, 8)}`,
    nodeUrl: env.GITLAWB_NODE_URL,
  });
}

export async function handleGitlawbSetupInfo(_req: Request, res: Response): Promise<void> {
  const webhookUrl = `${env.SERVER_URL}/api/webhook/gitlawb`;
  res.json({
    ok: true,
    platform: "gitlawb",
    nodeUrl: env.GITLAWB_NODE_URL,
    webhookUrl,
    docs: {
      start: "https://gitlawb.com/start",
      agents: "https://gitlawb.com/agents",
      node: "https://gitlawb.com/node",
    },
    webhookCommand: [
      "gl webhook create YOUR_REPO \\",
      `  --url ${webhookUrl} \\`,
      "  --events push \\",
      "  --secret YOUR_SECRET",
      "",
      `# Set on backend: GITLAWB_WEBHOOK_SECRET=YOUR_SECRET`,
      `# Node: export GITLAWB_NODE=https://node.gitlawb.com`,
    ].join("\n"),
    repoFormat: "{ownerShort}/{repoName}  (ownerShort = last segment of your did:key)",
    installCli: "curl -fsSL https://gitlawb.com/install.sh | sh",
  });
}
