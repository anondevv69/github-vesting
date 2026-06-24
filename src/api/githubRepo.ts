/**
 * GET /api/github/repo?repo=owner/name
 * Check that a public GitHub repository exists (setup wizard validation).
 */

import { Octokit } from "@octokit/rest";
import type { Request, Response } from "express";
import { normalizeRepoFullName, splitRepo } from "../lib/repoId";

export async function handleGithubRepoLookup(req: Request, res: Response): Promise<void> {
  const repoInput = String(req.query["repo"] ?? "").trim();
  if (!repoInput) {
    res.status(400).json({ ok: false, error: "repo query param required (owner/name)" });
    return;
  }

  const normalized = normalizeRepoFullName(repoInput);
  const [owner, repo] = splitRepo(normalized, "github");

  try {
    const octokit = new Octokit();
    const { data } = await octokit.repos.get({ owner, repo });
    res.json({
      ok: true,
      repo: data.full_name,
      defaultBranch: data.default_branch,
      private: data.private,
    });
  } catch {
    res.status(404).json({ ok: false, error: "Repository not found on GitHub" });
  }
}
