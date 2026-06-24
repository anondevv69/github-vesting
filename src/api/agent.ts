/**
 * Bankr agent API — tweet/DM-friendly vesting reads for @bankrbot skills.
 *
 * GET /api/agent/briefing?wallet=0x…  (or header x-wallet-address)
 * GET /api/agent/grants?wallet=0x…
 * GET /api/agent/status?repo=owner/repo
 * GET /api/agent/setup-link?wallet=0x…
 */

import type { Request, Response } from "express";
import { env } from "../lib/env";
import {
  fetchGrantsForRecipient,
  fetchGrantStatus,
  formatTokenAmount,
  isValidWallet,
} from "../lib/grantsHelper";

const IS_TESTNET = process.env.VITE_CHAIN === "base-sepolia";
const explorerBase = IS_TESTNET ? "https://sepolia.basescan.org" : "https://basescan.org";

function resolveWallet(req: Request): string | null {
  const header = req.headers["x-wallet-address"];
  const query = req.query["wallet"] ?? req.query["recipient"];
  const raw = String(header ?? query ?? "").trim();
  if (!isValidWallet(raw)) return null;
  return raw.toLowerCase();
}

function statusUrl(repoFullName: string): string {
  const [owner, name] = repoFullName.split("/");
  return `${env.FRONTEND_URL}/lock/${owner}/${name}`;
}

function setupUrl(): string {
  return `${env.FRONTEND_URL}/create`;
}

function dashboardUrl(): string {
  return `${env.FRONTEND_URL}/`;
}

function buildGrantSummary(
  repoFullName: string,
  progress: {
    verifiedPushCount: number;
    totalPushesRequired: number;
    pushesUntilNextRelease: number;
  },
  grant: { status: string; streaming: boolean; totalLocked: string; tokensPerMilestone: string },
): string {
  const mode = grant.streaming ? "streaming" : "escrow";
  const locked = formatTokenAmount(grant.totalLocked);
  const perMilestone = formatTokenAmount(grant.tokensPerMilestone);
  return (
    `${repoFullName} — ${grant.status} · ${mode}\n` +
    `${progress.verifiedPushCount}/${progress.totalPushesRequired} verified pushes` +
    ` · ${progress.pushesUntilNextRelease} until next release\n` +
    `${locked} locked · ${perMilestone} per milestone`
  );
}

export async function handleAgentBriefing(req: Request, res: Response): Promise<void> {
  const wallet = resolveWallet(req);
  if (!wallet) {
    res.status(400).json({ ok: false, error: "wallet query param or x-wallet-address header required (0x…)" });
    return;
  }

  const grants = await fetchGrantsForRecipient(wallet);

  if (grants.length === 0) {
    const link = setupUrl();
    const replyText = `No GitHub vesting locks for this wallet.\nLock tokens + link a repo:\n${link}`;
    res.json({
      ok: true,
      wallet,
      grantCount: 0,
      grants: [],
      replyText,
      tweetReply: replyText,
      links: { setup: link, dashboard: dashboardUrl() },
    });
    return;
  }

  const lines = grants.map(({ grant, progress }) =>
    buildGrantSummary(grant.repoFullName, progress, grant),
  );
  const primary = grants[0]!;
  const statusLink = statusUrl(primary.grant.repoFullName);

  const replyText =
    `GitHub vesting — ${grants.length} lock${grants.length === 1 ? "" : "s"}\n\n` +
    lines.join("\n\n") +
    `\n\n${statusLink}`;

  res.json({
    ok: true,
    wallet,
    grantCount: grants.length,
    grants: grants.map(({ grant, progress }) => ({
      repoFullName: grant.repoFullName,
      status: grant.status,
      streaming: grant.streaming,
      chain: grant.chain,
      progress,
      statusUrl: statusUrl(grant.repoFullName),
      lockTxUrl: `${explorerBase}/tx/${grant.onChainTxHash}`,
    })),
    replyText,
    tweetReply: replyText,
    links: {
      setup: setupUrl(),
      dashboard: dashboardUrl(),
      primaryStatus: statusLink,
    },
  });
}

export async function handleAgentGrants(req: Request, res: Response): Promise<void> {
  const wallet = resolveWallet(req);
  if (!wallet) {
    res.status(400).json({ ok: false, error: "wallet query param or x-wallet-address header required (0x…)" });
    return;
  }

  const grants = await fetchGrantsForRecipient(wallet);
  res.json({
    ok: true,
    wallet,
    grants: grants.map(({ grant, progress, recentPushes }) => ({
      repoFullName: grant.repoFullName,
      status: grant.status,
      streaming: grant.streaming,
      token: grant.token,
      chain: grant.chain,
      totalLocked: grant.totalLocked,
      totalLockedFormatted: formatTokenAmount(grant.totalLocked),
      progress,
      recentPushes,
      statusUrl: statusUrl(grant.repoFullName),
      dashboardUrl: dashboardUrl(),
    })),
  });
}

export async function handleAgentStatus(req: Request, res: Response): Promise<void> {
  const repo = String(req.query["repo"] ?? req.query["repoFullName"] ?? "").trim();
  if (!repo) {
    res.status(400).json({ ok: false, error: "repo query param required (owner/repo)" });
    return;
  }

  const data = await fetchGrantStatus(repo);
  if (!data) {
    res.status(404).json({ ok: false, error: "No vesting grant found for this repo" });
    return;
  }

  const { grant, progress, recentPushes } = data;
  const link = statusUrl(grant.repoFullName);
  const replyText =
    `GitHub vesting — ${grant.repoFullName}\n` +
    `${progress.verifiedPushCount}/${progress.totalPushesRequired} verified pushes` +
    ` · ${progress.pushesUntilNextRelease} until next release\n` +
    `${grant.status} · ${formatTokenAmount(grant.totalLocked)} locked\n\n` +
    link;

  res.json({
    ok: true,
    grant,
    progress,
    recentPushes,
    replyText,
    tweetReply: replyText,
    links: { status: link, lockTx: `${explorerBase}/tx/${grant.onChainTxHash}` },
  });
}

export async function handleAgentSetupLink(req: Request, res: Response): Promise<void> {
  const wallet = resolveWallet(req);
  const setup = setupUrl();
  const dashboard = dashboardUrl();

  const replyText = wallet
    ? `Start GitHub vesting (wallet ${wallet.slice(0, 6)}…${wallet.slice(-4)}):\n${setup}`
    : `Start GitHub vesting — connect wallet on Base:\n${setup}`;

  res.json({
    ok: true,
    wallet: wallet ?? null,
    setupUrl: setup,
    dashboardUrl: dashboard,
    replyText,
    tweetReply: replyText,
    links: { setup, dashboard },
    steps: [
      "Connect wallet + GitHub",
      "Enter repo + token + schedule",
      "Approve + lock on Base",
      "Install GitHub App + activate",
    ],
  });
}
