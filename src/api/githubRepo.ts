/**
 * GET /api/github/repo?repo=owner/name
 * GET /api/github/repos  — list repos for logged-in user (incl. private)
 */

import { Octokit } from "@octokit/rest";
import type { Request, Response } from "express";
import { normalizeRepoFullName, splitRepo } from "../lib/repoId";
import { resolveInstallationForRepo, getRepoInfo } from "../github/githubApp";
import { getGithubSession, octokitForSession } from "../lib/githubSession";

async function suggestRepos(owner: string, repoName: string, octokit?: Octokit): Promise<string[]> {
  try {
    const client = octokit ?? new Octokit();
    const { data } = await client.repos.listForUser({ username: owner, per_page: 100 });
    const needle = repoName.toLowerCase().replace(/[^a-z0-9]/g, "");
    return data
      .map((r) => r.full_name)
      .filter((name): name is string => Boolean(name))
      .filter((full) => {
        const short = full.split("/")[1]!.toLowerCase();
        return short.includes(needle) || needle.includes(short.slice(0, 6));
      })
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function lookupRepo(
  owner: string,
  repo: string,
  sessionOctokit?: Octokit,
): Promise<{ data: { full_name: string; default_branch: string; private: boolean }; via: string } | null> {
  const installId = await resolveInstallationForRepo(owner, repo);
  if (installId) {
    try {
      const info = await getRepoInfo(installId, owner, repo);
      return {
        data: {
          full_name: `${owner}/${repo}`,
          default_branch: info.default_branch,
          private: info.private,
        },
        via: "github-app",
      };
    } catch {
      /* fall through */
    }
  }

  if (sessionOctokit) {
    try {
      const { data } = await sessionOctokit.repos.get({ owner, repo });
      return { data, via: "oauth-session" };
    } catch {
      /* fall through */
    }
  }

  try {
    const { data } = await new Octokit().repos.get({ owner, repo });
    return { data, via: "public-api" };
  } catch {
    return null;
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
  const session = await getGithubSession(req);
  const sessionOctokit = session ? octokitForSession(session) : undefined;

  const hit = await lookupRepo(owner, repo, sessionOctokit);
  if (hit) {
    res.json({
      ok: true,
      repo: hit.data.full_name,
      defaultBranch: hit.data.default_branch,
      private: hit.data.private,
      via: hit.via,
      githubUser: session?.login,
    });
    return;
  }

  const suggestions = await suggestRepos(owner, repo, sessionOctokit);
  const hint = !session
    ? "Connect GitHub on this site to validate private repos you can access."
    : suggestions.length > 0
      ? `Did you mean: ${suggestions.join(", ")}?`
      : "Create the repo on GitHub first, or check owner/name spelling.";

  res.status(404).json({
    ok: false,
    error: "Repository not found on GitHub",
    repo: normalized,
    hint,
    suggestions,
    needsGitHubLogin: !session,
  });
}

export async function handleGithubReposList(req: Request, res: Response): Promise<void> {
  const session = await getGithubSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: "Connect GitHub to list your repositories" });
    return;
  }

  const perPage = Math.min(Number(req.query["per_page"] ?? 100), 100);

  try {
    const octokit = octokitForSession(session);
    const { data } = await octokit.repos.listForAuthenticatedUser({
      affiliation: "owner,collaborator,organization_member",
      per_page: perPage,
      sort: "updated",
    });
    const repos = data.map((r) => ({
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      permissions: r.permissions,
    }));
    res.json({ ok: true, login: session.login, repos });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : "Failed to list repositories",
    });
  }
}

export { lookupRepo };
