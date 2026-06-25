/**
 * Link wallets to GitHub dev profiles.
 *
 * POST /api/dev/link-wallet/challenge  (GitHub session + wallet)
 * POST /api/dev/link-wallet/confirm    (GitHub session + signature)
 * GET  /api/dev/link-wallet/:login
 */

import type { Request, Response } from "express";
import { isValidWallet } from "../lib/grantsHelper";
import { getGithubSession } from "../lib/githubSession";
import {
  confirmWalletLink,
  createWalletLinkChallenge,
  listLinkedWallets,
} from "../lib/devWallets";
import { fetchFeeRecipientTokens } from "../lib/walletTokens";
import { createGithubMagicLink, completeGithubMagicLink } from "../lib/githubMagicLink";
import { env } from "../lib/env";

function resolveWallet(req: Request): string | null {
  const raw = String(
    req.headers["x-wallet-address"] ?? req.body?.wallet ?? req.query["wallet"] ?? "",
  ).trim();
  return isValidWallet(raw) ? raw.toLowerCase() : null;
}

export async function handleListLinkedWallets(req: Request, res: Response): Promise<void> {
  const login = String(req.params["login"] ?? "").trim().toLowerCase();
  if (!login) {
    res.status(400).json({ ok: false, error: "login required" });
    return;
  }
  if (login === "challenge" || login === "confirm" || login === "magic-session") {
    res.status(405).json({
      ok: false,
      error: `Use POST /api/dev/link-wallet/${login} — this path is not a GitHub username`,
    });
    return;
  }

  const wallets = await listLinkedWallets(login);
  const session = await getGithubSession(req);
  const isSelf = session?.login.toLowerCase() === login;

  let feeRecipientTokens: Awaited<ReturnType<typeof fetchFeeRecipientTokens>>[] = [];
  if (wallets.length > 0) {
    feeRecipientTokens = await Promise.all(
      wallets.map((w) => fetchFeeRecipientTokens(w.wallet)),
    );
  }

  res.json({
    ok: true,
    githubLogin: login,
    wallets,
    feeRecipientTokens: wallets.map((w, i) => ({
      wallet: w.wallet,
      source: w.source,
      linkedAt: w.linkedAt,
      tokens: feeRecipientTokens[i] ?? [],
    })),
    canLink: isSelf,
  });
}

export async function handleWalletLinkChallenge(req: Request, res: Response): Promise<void> {
  const session = await getGithubSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: "GitHub login required" });
    return;
  }

  const wallet = resolveWallet(req);
  if (!wallet) {
    res.status(400).json({ ok: false, error: "wallet required (connect wallet or x-wallet-address)" });
    return;
  }

  try {
    const challenge = await createWalletLinkChallenge(session.login, wallet);
    res.json({
      ok: true,
      githubLogin: session.login,
      wallet,
      signMessage: challenge.signMessage,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : "Challenge failed" });
  }
}

export async function handleWalletLinkConfirm(req: Request, res: Response): Promise<void> {
  const session = await getGithubSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: "GitHub login required" });
    return;
  }

  const wallet = resolveWallet(req);
  const signature = String(req.body?.signature ?? "").trim();
  const signMessage = String(req.body?.signMessage ?? "").trim();

  if (!wallet || !signature || !signMessage) {
    res.status(400).json({ ok: false, error: "wallet, signature, and signMessage required" });
    return;
  }

  try {
    const wallets = await confirmWalletLink(session.login, wallet, signature, signMessage);
    res.json({ ok: true, githubLogin: session.login, wallets });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : "Link failed" });
  }
}

/** GitHub session + connected wallet — no personal_sign (Bankr Kernel / smart wallets). */
export async function handleWalletLinkMagicSession(req: Request, res: Response): Promise<void> {
  const session = await getGithubSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: "GitHub login required" });
    return;
  }

  const wallet = resolveWallet(req);
  if (!wallet) {
    res.status(400).json({ ok: false, error: "wallet required (connect wallet or x-wallet-address)" });
    return;
  }

  try {
    const link = await createGithubMagicLink(wallet, session.login);
    const result = await completeGithubMagicLink(link.token, session.login);
    res.json({
      ok: true,
      githubLogin: result.githubLogin,
      wallet: result.wallet,
      wallets: result.wallets,
      profileUrl: `${env.FRONTEND_URL}/dev/${result.githubLogin}`,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : "Link failed" });
  }
}
