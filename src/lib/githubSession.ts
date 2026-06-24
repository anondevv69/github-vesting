/**
 * Server-side GitHub OAuth sessions (httpOnly cookie + Redis).
 */

import { randomBytes } from "crypto";
import type { Request, Response } from "express";
import { Octokit } from "@octokit/rest";
import { env } from "./env";
import { getRedis, KEYS } from "./redis";

const SESSION_COOKIE = "github_vesting_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

export type GithubSession = {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string;
  accessToken: string;
  createdAt: string;
};

export type GithubPublicUser = {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string;
};

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie ?? "";
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function cookieDomainAttr(): string {
  try {
    const host = new URL(env.FRONTEND_URL).hostname;
    if (host === "localhost" || host === "127.0.0.1") return "";
    const parts = host.split(".");
    if (parts.length >= 2) return `Domain=.${parts.slice(-2).join(".")}`;
  } catch {
    /* ignore */
  }
  return "";
}

export function setSessionCookie(res: Response, sessionId: string): void {
  const secure = env.NODE_ENV === "production";
  const domain = cookieDomainAttr();
  const bits = [
    `${SESSION_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    secure ? "Secure" : "",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SEC}`,
    domain,
  ].filter(Boolean);
  res.setHeader("Set-Cookie", bits.join("; "));
}

export function clearSessionCookie(res: Response): void {
  const secure = env.NODE_ENV === "production";
  const domain = cookieDomainAttr();
  const bits = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    secure ? "Secure" : "",
    "SameSite=Lax",
    "Max-Age=0",
    domain,
  ].filter(Boolean);
  res.setHeader("Set-Cookie", bits.join("; "));
}

export async function createGithubSession(user: {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string;
  accessToken: string;
}): Promise<string> {
  const sessionId = randomBytes(24).toString("hex");
  const session: GithubSession = {
    login: user.login,
    id: user.id,
    name: user.name,
    avatarUrl: user.avatarUrl,
    accessToken: user.accessToken,
    createdAt: new Date().toISOString(),
  };
  await getRedis().set(KEYS.githubSession(sessionId), JSON.stringify(session), "EX", SESSION_TTL_SEC);
  return sessionId;
}

export async function getGithubSession(req: Request): Promise<GithubSession | null> {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (!sessionId) return null;
  const raw = await getRedis().get(KEYS.githubSession(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GithubSession;
  } catch {
    return null;
  }
}

export function toPublicUser(session: GithubSession): GithubPublicUser {
  return {
    login: session.login,
    id: session.id,
    name: session.name,
    avatarUrl: session.avatarUrl,
  };
}

export function octokitForSession(session: GithubSession): Octokit {
  return new Octokit({ auth: session.accessToken });
}

export async function destroyGithubSession(req: Request, res: Response): Promise<void> {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (sessionId) await getRedis().del(KEYS.githubSession(sessionId));
  clearSessionCookie(res);
}
