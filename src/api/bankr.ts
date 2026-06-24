/**
 * GET /api/bankr/fee-tokens?wallet=0x…
 *   Lists Bankr-launched tokens where the wallet is a fee beneficiary.
 *
 * GET /api/bankr/token-info?token=0x…
 *   Fee recipient + metadata for a Bankr-launched token (Doppler).
 */

import type { Request, Response } from "express";
import { isValidWallet } from "../lib/grantsHelper";

const BANKR_API = "https://api.bankr.bot";

type BankrCreatorFeesResponse = {
  address: string;
  chain: string;
  tokens: Array<{
    tokenAddress: string;
    name?: string;
    symbol?: string;
    share?: string;
  }>;
};

export async function handleBankrFeeTokens(req: Request, res: Response): Promise<void> {
  const wallet = String(req.query["wallet"] ?? "").trim().toLowerCase();
  if (!isValidWallet(wallet)) {
    res.status(400).json({ ok: false, error: "wallet query param required (0x…)" });
    return;
  }

  try {
    const upstream = await fetch(`${BANKR_API}/public/doppler/creator-fees/${wallet}`);
    if (!upstream.ok) {
      res.status(502).json({ ok: false, error: `Bankr API returned ${upstream.status}` });
      return;
    }

    const data = (await upstream.json()) as BankrCreatorFeesResponse;
    const tokens = (data.tokens ?? []).map((t) => ({
      address: t.tokenAddress,
      name: t.name ?? "",
      symbol: t.symbol ?? "",
      share: t.share ?? "",
      chain: data.chain ?? "base",
    }));

    res.json({
      ok: true,
      wallet,
      source: "bankr.creator-fees",
      tokens,
      docs: "https://docs.bankr.bot/token-launching/transferring-fees",
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : "Failed to reach Bankr API",
    });
  }
}

type BankrTokenFeesResponse = {
  address: string;
  chain: string;
  tokens: Array<{
    tokenAddress: string;
    name?: string;
    symbol?: string;
    share?: string;
    initializer?: string;
    poolId?: string;
  }>;
};

export type BankrTokenInfo = {
  tokenAddress: string;
  name: string;
  symbol: string;
  feeBeneficiary: string;
  feeShare: string;
  initializer?: string;
  poolId?: string;
  chain: string;
  bankrUrl: string;
  source: "bankr.doppler";
};

export async function fetchBankrTokenInfo(tokenAddress: string): Promise<BankrTokenInfo | null> {
  const token = tokenAddress.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(token)) return null;

  try {
    const upstream = await fetch(`${BANKR_API}/public/doppler/token-fees/${token}`);
    if (!upstream.ok) return null;

    const data = (await upstream.json()) as BankrTokenFeesResponse;
    const match = (data.tokens ?? []).find((t) => t.tokenAddress.toLowerCase() === token);
    if (!match) return null;

    return {
      tokenAddress: match.tokenAddress,
      name: match.name ?? "",
      symbol: match.symbol ?? "",
      feeBeneficiary: data.address,
      feeShare: match.share ?? "",
      initializer: match.initializer,
      poolId: match.poolId,
      chain: data.chain ?? "base",
      bankrUrl: `https://www.bankr.space/community/${match.tokenAddress}`,
      source: "bankr.doppler",
    };
  } catch {
    return null;
  }
}

export async function handleBankrTokenInfo(req: Request, res: Response): Promise<void> {
  const token = String(req.query["token"] ?? req.query["address"] ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(token)) {
    res.status(400).json({ ok: false, error: "token query param required (0x…)" });
    return;
  }

  const info = await fetchBankrTokenInfo(token);
  if (!info) {
    res.json({ ok: true, bankr: null });
    return;
  }

  res.json({ ok: true, bankr: info });
}
