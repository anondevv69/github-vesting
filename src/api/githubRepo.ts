/**
 * GET /api/github/repo?repo=owner/name
 * Check that a GitHub repository exists (public API or App installation).
 */

import { Octokit } from "@octokit/rest";
import type { Request, Response } from "express";
import { normalizeRepoFullName, splitRepo } from "../lib/repoId";
import { resolveInstallationForRepo, getRepoInfo } from "../github/githubApp";

async function suggestRepos(owner: string, repoName: string): Promise<string[]> {
  try {
    const octokit = new Octokit();
    const { data } = await octokit.repos.listForUser({ username: owner, per_page: 100 });
    const needle = repoName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const scored = data
      .map((r) => r.full_name)
      .filter((name): name is string => Boolean(name))
      .map((full) => {
        const short = full.split("/")[1]!.toLowerCase();
        const hit =
          short.includes(needle) ||
          needle.includes(short) ||
          short.replace(/[^a-z0-9]/g, "").includes(needle.slice(0, 6));
        return { full, hit };
      })
      .filter((x) => x.hit)
      .map((x) => x.full);
    return scored.slice(0, 5);
  } catch {
    return [];
  }
}

export async function handleGithubRepoLookup(req: Request, res: Response): Promise<void> {
  const repoInput = String(req.query["repo"] ?? "").trim();
  if (!repoInput) {
    res.status(400).json({ ok: false, error: "repo query param required (owner/name)" });
    return;
  }

  const normalized = normalizeRepoFullName(repoInput);
  const [owner, repo] = splitRepo(normalized, "github");

  const installId = await resolveInstallationForRepo(owner, repo);
  if (installId) {
    try {
      const info = await getRepoInfo(installId, owner, repo);
      res.json({
        ok: true,
        repo: `${owner}/${repo}`,
        defaultBranch: info.default_branch,
        private: info.private,
        via: "github-app",
      });
      return;
    } catch {
      /* fall through to public lookup */
    }
  }

  try {
    const octokit = new Octokit();
    const { data } = await octokit.repos.get({ owner, repo });
    res.json({
      ok: true,
      repo: data.full_name,
      defaultBranch: data.default_branch,
      private: data.private,
      via: "public-api",
    });
  } catch {
    const suggestions = await suggestRepos(owner, repo);
    const hint =
      suggestions.length > 0
        ? `Did you mean: ${suggestions.join(", ")}?`
        : `Create the repo on GitHub first, or check owner/name spelling.`;

    res.status(404).json({
      ok: false,
      error: "Repository not found on GitHub",
      repo: normalized,
      hint,
      suggestions,
    });
  }
}
