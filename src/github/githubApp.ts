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
    permission: "pull", // read-only — we just verify, not write
  });
}

/**
 * Get repository metadata using an installation token.
 */
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

/**
 * Verify a GitHub OAuth access token and return the authenticated user.
 */
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

/**
 * Validate that the target repo's default branch exists and is accessible.
 */
export async function validateRepoAccess(
  installationId: number,
  owner: string,
  repo: string,
): Promise<{ valid: boolean; defaultBranch: string; isPrivate: boolean }> {
  try {
    const info = await getRepoInfo(installationId, owner, repo);
    return {
      valid: true,
      defaultBranch: info.default_branch,
      isPrivate: info.private,
    };
  } catch {
    return { valid: false, defaultBranch: "main", isPrivate: false };
  }
}
