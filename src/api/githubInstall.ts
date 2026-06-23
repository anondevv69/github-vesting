/**
 * GET /api/github/installation?repo=owner/name
 * Returns GitHub App installation id for a repo (if the app is installed there).
 */

import type { Request, Response } from "express";
import { resolveInstallationForRepo, listInstallationRepos, validateRepoAccess } from "../github/githubApp";
import { normalizeRepoFullName, splitRepo } from "../lib/repoId";

export async function handleGithubInstallationLookup(req: Request, res: Response): Promise<void> {
  const repoInput = String(req.query["repo"] ?? "");
  const installationIdParam = req.query["installationId"];

  if (!repoInput) {
    res.status(400).json({ ok: false, error: "repo query param required (owner/name)" });
    return;
  }

  const normalizedRepo = normalizeRepoFullName(repoInput);
  const [owner, repo] = splitRepo(normalizedRepo, "github");

  const resolvedId = await resolveInstallationForRepo(owner, repo);
  const installationId = resolvedId ?? (installationIdParam ? Number(installationIdParam) : null);

  if (!installationId) {
    res.json({
      ok: false,
      error: "No GitHub App installation found for this repo",
      repo: normalizedRepo,
      hint: "Install the GitHub App on this repository and select it in the install flow.",
    });
    return;
  }

  const access = await validateRepoAccess(installationId, owner, repo);

  res.json({
    ok: access.valid,
    repo: normalizedRepo,
    installationId,
    resolvedAutomatically: resolvedId !== null,
    defaultBranch: access.defaultBranch,
    installedRepos: access.installedRepos,
    error: access.error,
  });
}
