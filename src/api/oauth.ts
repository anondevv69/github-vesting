/**
 * GitHub OAuth flow:
 *   GET /api/oauth/github          — redirect to GitHub authorize
 *   GET /api/oauth/github/callback — exchange code, store user session
 */

import type { Request, Response } from "express";
import { randomBytes } from "crypto";
import { env } from "../lib/env";
import { getOAuthUser } from "../github/githubApp";
import { getRedis, KEYS } from "../lib/redis";

const SCOPES = "read:user,repo";

const ALLOWED_RETURN_PATHS = ["/create", "/vesting/setup", "/vesting/dashboard"] as const;

function sanitizeReturnTo(raw: unknown): string {
  const fallback = "/create";
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const path = raw.startsWith("/") ? raw.split("?")[0]! : (() => {
    try {
      return new URL(raw).pathname;
    } catch {
      return "";
    }
  })();
  if ((ALLOWED_RETURN_PATHS as readonly string[]).includes(path)) return path;
  if (path === "/vesting/setup") return "/create";
  return fallback;
}

export function handleOAuthRedirect(req: Request, res: Response): void {
  const state = randomBytes(16).toString("hex");
  const returnTo = sanitizeReturnTo(req.query["returnTo"]);
  const redis = getRedis();
  void redis.set(KEYS.oauthState(state), JSON.stringify({ returnTo }), "EX", 600);

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
  try {
    returnTo = sanitizeReturnTo(JSON.parse(storedRaw).returnTo);
  } catch {
    /* legacy state value "1" */
  }

  try {
    const user = await getOAuthUser(code);
    const sessionData = encodeURIComponent(
      JSON.stringify({ login: user.login, id: user.id, name: user.name, avatarUrl: user.avatarUrl }),
    );
    res.redirect(`${env.FRONTEND_URL}${returnTo}?github_user=${sessionData}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.redirect(`${env.FRONTEND_URL}${returnTo}?error=${encodeURIComponent(msg)}`);
  }
}
