/**
 * GET /api/bankr/fee-tokens?wallet=0x…
 *
 * Lists Bankr-launched tokens where the wallet is a fee beneficiary
 * (proxies api.bankr.bot/public/doppler/creator-fees).
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
