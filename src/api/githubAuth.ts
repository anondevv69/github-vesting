/**
 * GitHub OAuth session endpoints.
 */

import type { Request, Response } from "express";
import {
  createGithubSession,
  destroyGithubSession,
  getGithubSession,
  setSessionCookie,
  toPublicUser,
} from "../lib/githubSession";
import { getOAuthUser } from "../github/githubApp";

export async function handleGithubAuthMe(req: Request, res: Response): Promise<void> {
  const session = await getGithubSession(req);
  if (!session) {
    res.json({ ok: true, github: null });
    return;
  }
  res.json({ ok: true, github: toPublicUser(session) });
}

export async function handleGithubAuthLogout(req: Request, res: Response): Promise<void> {
  await destroyGithubSession(req, res);
  res.json({ ok: true });
}

/** Called from OAuth callback after code exchange. */
export async function finishGithubOAuth(
  res: Response,
  code: string,
): Promise<{ login: string; id: number; name: string | null; avatarUrl: string }> {
  const user = await getOAuthUser(code);
  const sessionId = await createGithubSession(user);
  setSessionCookie(res, sessionId);
  return {
    login: user.login,
    id: user.id,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };
}
