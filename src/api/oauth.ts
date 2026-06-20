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

export function handleOAuthRedirect(req: Request, res: Response): void {
  const state = randomBytes(16).toString("hex");
  const redis = getRedis();
  void redis.set(KEYS.oauthState(state), "1", "EX", 600); // 10 min expiry

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
  const stored = await redis.get(KEYS.oauthState(state));
  if (!stored) {
    res.status(400).json({ ok: false, error: "Invalid or expired OAuth state" });
    return;
  }
  await redis.del(KEYS.oauthState(state));

  try {
    const user = await getOAuthUser(code);
    // Store in session (express-session or JWT cookie — simplified here as query param for SPA).
    const sessionData = encodeURIComponent(
      JSON.stringify({ login: user.login, id: user.id, name: user.name, avatarUrl: user.avatarUrl }),
    );
    res.redirect(`${env.FRONTEND_URL}/vesting/dashboard?github_user=${sessionData}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.redirect(`${env.FRONTEND_URL}/vesting/dashboard?error=${encodeURIComponent(msg)}`);
  }
}
