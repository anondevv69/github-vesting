/**
 * GitHub OAuth flow:
 *   GET /api/oauth/github          — redirect to GitHub authorize
 *   GET /api/oauth/github/callback — exchange code, store user session
 */

import type { Request, Response } from "express";
import { randomBytes } from "crypto";
import { env } from "../lib/env";
import { getRedis, KEYS } from "../lib/redis";
import { finishGithubOAuth } from "./githubAuth";
import { completeGithubMagicLink } from "../lib/githubMagicLink";

const SCOPES = "read:user,repo";

const ALLOWED_RETURN_PATHS = ["/", "/create", "/help", "/link-github", "/vesting/setup", "/vesting/dashboard"] as const;

function sanitizeReturnTo(raw: unknown): string {
  const fallback = "/";
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const path = raw.startsWith("/") ? raw.split("?")[0]! : (() => {
    try {
      return new URL(raw).pathname;
    } catch {
      return "";
    }
  })();
  if ((ALLOWED_RETURN_PATHS as readonly string[]).includes(path)) return path;
  if (path.startsWith("/dev/") || path.startsWith("/lock/")) return path;
  if (path === "/vesting/setup") return "/create";
  if (path === "/vesting/dashboard") return "/";
  return fallback;
}

export function handleOAuthRedirect(req: Request, res: Response): void {
  const state = randomBytes(16).toString("hex");
  const returnTo = sanitizeReturnTo(req.query["returnTo"]);
  const linkTokenRaw = String(req.query["linkToken"] ?? "").trim().toLowerCase();
  const linkToken = /^[a-f0-9]{48}$/.test(linkTokenRaw) ? linkTokenRaw : undefined;
  const redis = getRedis();
  void redis.set(
    KEYS.oauthState(state),
    JSON.stringify({ returnTo, linkToken }),
    "EX",
    600,
  );

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${env.SERVER_URL}/api/oauth/github/callback`,
    scope: SCOPES,
    state,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
}

export async function handleOAuthCallback(req: Request, res: Response): Promise<void> {
  const code = req.query["code"] as string | undefined;
  const state = req.query["state"] as string | undefined;

  if (!code || !state) {
    res.status(400).json({ ok: false, error: "Missing code or state" });
    return;
  }

  const redis = getRedis();
  const storedRaw = await redis.get(KEYS.oauthState(state));
  if (!storedRaw) {
    res.status(400).json({ ok: false, error: "Invalid or expired OAuth state" });
    return;
  }
  await redis.del(KEYS.oauthState(state));

  let returnTo = "/create";
  let linkToken: string | undefined;
  try {
    const parsed = JSON.parse(storedRaw) as { returnTo?: string; linkToken?: string };
    returnTo = sanitizeReturnTo(parsed.returnTo);
    const rawToken = String(parsed.linkToken ?? "").trim().toLowerCase();
    linkToken = /^[a-f0-9]{48}$/.test(rawToken) ? rawToken : undefined;
  } catch {
    /* legacy state value "1" */
  }

  try {
    const user = await finishGithubOAuth(res, code);
    const sessionData = encodeURIComponent(
      JSON.stringify({ login: user.login, id: user.id, name: user.name, avatarUrl: user.avatarUrl }),
    );

    if (linkToken) {
      try {
        const result = await completeGithubMagicLink(linkToken, user.login);
        const profilePath = `/dev/${result.githubLogin}`;
        res.redirect(
          `${env.FRONTEND_URL}${profilePath}?wallet_linked=1&github_user=${sessionData}`,
        );
        return;
      } catch (linkErr) {
        const msg = linkErr instanceof Error ? linkErr.message : String(linkErr);
        res.redirect(
          `${env.FRONTEND_URL}/link-github?t=${linkToken}&error=${encodeURIComponent(msg)}`,
        );
        return;
      }
    }

    res.redirect(`${env.FRONTEND_URL}${returnTo}?github_user=${sessionData}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.redirect(`${env.FRONTEND_URL}${returnTo}?error=${encodeURIComponent(msg)}`);
  }
}
