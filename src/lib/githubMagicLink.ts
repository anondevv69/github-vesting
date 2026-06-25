/**
 * One-time magic links: bind a Bankr wallet (from agent API) to a GitHub login via OAuth.
 */

import { randomBytes } from "crypto";
import { env } from "./env";
import { isValidWallet } from "./grantsHelper";
import { addLinkedWallet, type LinkedWallet } from "./devWallets";
import { getRedis, KEYS } from "./redis";

const MAGIC_LINK_TTL_SEC = 60 * 15;

export type PendingGithubMagicLink = {
  wallet: string;
  githubLogin: string;
  createdAt: string;
  expiresAt: string;
};

const GITHUB_LOGIN_RE = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export function normalizeGithubLogin(raw: string): string | null {
  const login = raw.trim().replace(/^@/, "").toLowerCase();
  if (!login || !GITHUB_LOGIN_RE.test(login)) return null;
  return login;
}

export async function createGithubMagicLink(
  wallet: string,
  githubLogin: string,
): Promise<{ token: string; linkUrl: string; expiresAt: string; githubLogin: string; wallet: string }> {
  if (!isValidWallet(wallet)) throw new Error("Invalid wallet address");
  const login = normalizeGithubLogin(githubLogin);
  if (!login) throw new Error("Invalid GitHub username");

  const addr = wallet.toLowerCase();
  const token = randomBytes(24).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_SEC * 1000).toISOString();

  const pending: PendingGithubMagicLink = {
    wallet: addr,
    githubLogin: login,
    createdAt: now.toISOString(),
    expiresAt,
  };

  await getRedis().set(
    KEYS.githubMagicLink(token),
    JSON.stringify(pending),
    "EX",
    MAGIC_LINK_TTL_SEC,
  );

  const linkUrl = `${env.FRONTEND_URL}/link-github?t=${token}`;
  return { token, linkUrl, expiresAt, githubLogin: login, wallet: addr };
}

export async function getGithubMagicLink(token: string): Promise<PendingGithubMagicLink | null> {
  const id = token.trim().toLowerCase();
  if (!/^[a-f0-9]{48}$/.test(id)) return null;
  const raw = await getRedis().get(KEYS.githubMagicLink(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingGithubMagicLink;
  } catch {
    return null;
  }
}

export async function completeGithubMagicLink(
  token: string,
  authenticatedGithubLogin: string,
): Promise<{ wallets: LinkedWallet[]; githubLogin: string; wallet: string }> {
  const pending = await getGithubMagicLink(token);
  if (!pending) throw new Error("Link expired or invalid — ask @bankrbot for a new link");

  const login = normalizeGithubLogin(authenticatedGithubLogin);
  if (!login) throw new Error("Invalid GitHub session");

  if (login !== pending.githubLogin) {
    throw new Error(
      `Signed in as @${login}, but this link is for @${pending.githubLogin}. ` +
        `Sign out of GitHub and try again with the correct account.`,
    );
  }

  await getRedis().del(KEYS.githubMagicLink(token.trim().toLowerCase()));
  const wallets = await addLinkedWallet(pending.githubLogin, pending.wallet, "bankr");
  return { wallets, githubLogin: pending.githubLogin, wallet: pending.wallet };
}
