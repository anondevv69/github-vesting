import { App } from "@octokit/app";
import { env } from "../lib/env";

let _app: App | null = null;

export function getGithubApp(): App {
  if (!_app) {
    _app = new App({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      webhooks: { secret: env.GITHUB_WEBHOOK_SECRET },
      oauth: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    });
  }
  return _app;
}

export type RepoAccessResult = {
  valid: boolean;
  defaultBranch: string;
  isPrivate: boolean;
  error?: string;
  /** Repos the installation can access (when validation fails). */
  installedRepos?: string[];
};

/** Resolve the GitHub App installation id for a repo (no user input needed). */
export async function resolveInstallationForRepo(
  owner: string,
  repo: string,
): Promise<number | null> {
  try {
    const app = getGithubApp();
    const { data } = await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo,
    });
    return data.id;
  } catch {
    return null;
  }
}

/** List repo full names accessible to an installation (for error hints). */
export async function listInstallationRepos(installationId: number): Promise<string[]> {
  const app = getGithubApp();
  const octokit = await app.getInstallationOctokit(installationId);
  const names: string[] = [];
  for await (const response of octokit.paginate.iterator(
    octokit.rest.apps.listReposAccessibleToInstallation,
    { per_page: 100 },
  )) {
    for (const r of response.data) {
      if (r.full_name) names.push(r.full_name);
    }
  }
  return names;
}

/**
 * Invite our GitHub App (bot) as a collaborator on the target repo.
 * The user must be the repo owner / have admin rights.
 */
export async function inviteBotAsCollaborator(
  installationId: number,
  owner: string,
  repo: string,
): Promise<void> {
  const app = getGithubApp();
  const octokit = await app.getInstallationOctokit(installationId);
  await octokit.request("PUT /repos/{owner}/{repo}/collaborators/{username}", {
    owner,
    repo,
    username: env.GITHUB_BOT_USERNAME,
    permission: "pull",
  });
}

export async function getRepoInfo(
  installationId: number,
  owner: string,
  repo: string,
) {
  const app = getGithubApp();
  const octokit = await app.getInstallationOctokit(installationId);
  const { data } = await octokit.request("GET /repos/{owner}/{repo}", {
    owner,
    repo,
  });
  return data;
}

export async function getOAuthUser(code: string): Promise<{
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string;
  accessToken: string;
}> {
  const app = getGithubApp();
  const { authentication } = await app.oauth.createToken({ code });
  const octokit = await app.oauth.getUserOctokit({ token: authentication.token });
  const { data: user } = await octokit.request("GET /user");
  return {
    login: user.login,
    id: user.id,
    name: user.name ?? null,
    avatarUrl: user.avatar_url,
    accessToken: authentication.token,
  };
}

export async function validateRepoAccess(
  installationId: number,
  owner: string,
  repo: string,
): Promise<RepoAccessResult> {
  try {
    const info = await getRepoInfo(installationId, owner, repo);
    return {
      valid: true,
      defaultBranch: info.default_branch,
      isPrivate: info.private,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    let installedRepos: string[] | undefined;
    try {
      installedRepos = await listInstallationRepos(installationId);
    } catch {
      /* installation id may be wrong app */
    }
    return {
      valid: false,
      defaultBranch: "main",
      isPrivate: false,
      error,
      installedRepos,
    };
  }
}
