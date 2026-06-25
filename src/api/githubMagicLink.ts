/**
 * GitHub ↔ Bankr wallet magic link (Flow B).
 *
 * POST /api/agent/link-github     — create one-time link (Bankr agent)
 * GET  /api/link-github/inspect   — validate token for landing page
 */

import type { Request, Response } from "express";
import { env } from "../lib/env";
import { isValidWallet } from "../lib/grantsHelper";
import {
  createGithubMagicLink,
  getGithubMagicLink,
  normalizeGithubLogin,
} from "../lib/githubMagicLink";

function resolveWallet(req: Request): string | null {
  const raw = String(
    req.headers["x-wallet-address"] ?? req.body?.wallet ?? req.query["wallet"] ?? "",
  ).trim();
  return isValidWallet(raw) ? raw.toLowerCase() : null;
}

function devProfileUrl(login: string): string {
  return `${env.FRONTEND_URL}/dev/${login}`;
}

export async function handleAgentLinkGithub(req: Request, res: Response): Promise<void> {
  const wallet = resolveWallet(req);
  if (!wallet) {
    res.status(400).json({
      ok: false,
      error: "wallet required — pass x-wallet-address header or wallet in body",
    });
    return;
  }

  const githubLogin = normalizeGithubLogin(
    String(req.body?.githubLogin ?? req.body?.github ?? req.body?.login ?? ""),
  );
  if (!githubLogin) {
    res.status(400).json({
      ok: false,
      error: "githubLogin required (e.g. anondevv69 or @anondevv69)",
    });
    return;
  }

  try {
    const link = await createGithubMagicLink(wallet, githubLogin);
    const profileUrl = devProfileUrl(githubLogin);
    const replyText =
      `Link GitHub @${githubLogin} to your Bankr wallet.\n\n` +
      `Open this link within 15 minutes (DM only — do not share):\n` +
      `${link.linkUrl}\n\n` +
      `Sign in with GitHub as @${githubLogin}. Your profile will show this wallet:\n` +
      profileUrl;

    res.json({
      ok: true,
      wallet: link.wallet,
      githubLogin: link.githubLogin,
      linkUrl: link.linkUrl,
      profileUrl,
      expiresAt: link.expiresAt,
      replyText,
      tweetReply: replyText,
      links: { link: link.linkUrl, profile: profileUrl },
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : "Link failed" });
  }
}

export async function handleInspectGithubMagicLink(req: Request, res: Response): Promise<void> {
  const token = String(req.query["t"] ?? req.query["token"] ?? "").trim();
  if (!token) {
    res.status(400).json({ ok: false, error: "token required" });
    return;
  }

  const pending = await getGithubMagicLink(token);
  if (!pending) {
    res.status(404).json({
      ok: false,
      error: "Link expired or invalid — ask @bankrbot: link github @yourusername",
    });
    return;
  }

  res.json({
    ok: true,
    githubLogin: pending.githubLogin,
    wallet: pending.wallet,
    expiresAt: pending.expiresAt,
    profileUrl: devProfileUrl(pending.githubLogin),
    oauthUrl: `${env.SERVER_URL}/api/oauth/github?returnTo=${encodeURIComponent(`/dev/${pending.githubLogin}`)}&linkToken=${token}`,
  });
}
