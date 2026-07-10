/**
 * GET /api/bankr/fee-tokens?wallet=0x…
 *   Lists Bankr-launched tokens where the wallet is a fee beneficiary.
 *
 * GET /api/bankr/token-info?token=0x…
 *   Fee recipient + metadata for a Bankr-launched token (Doppler).
 */

import type { Request, Response } from "express";
import { isValidWallet } from "../lib/grantsHelper";
import { parseVestingChain, type VestingChainKey } from "../lib/chains";

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

type BankrLaunchResponse = {
  launch?: {
    tokenAddress: string;
    tokenName?: string;
    tokenSymbol?: string;
    imageUri?: string;
    feeRecipient?: {
      walletAddress?: string;
      xUsername?: string;
      xProfileImageUrl?: string;
    };
    deployer?: {
      walletAddress?: string;
      xUsername?: string;
      xProfileImageUrl?: string;
    };
  };
};

export type BankrFeeRecipient = {
  wallet: string;
  xUsername?: string;
  xProfileImageUrl?: string;
};

export type BankrTokenInfo = {
  tokenAddress: string;
  name: string;
  symbol: string;
  imageUri?: string;
  feeRecipient: BankrFeeRecipient;
  launchUrl: string;
  source: "bankr.launch";
};

export function bankrLaunchUrl(tokenAddress: string, chain?: VestingChainKey | string | null): string {
  const key = parseVestingChain(chain ?? undefined);
  if (key === "robinhood") {
    return `https://hood.markets/?token=${tokenAddress.trim().toLowerCase()}`;
  }
  return `https://bankr.bot/launches/${tokenAddress.trim().toLowerCase()}`;
}

export async function fetchBankrTokenInfo(
  tokenAddress: string,
  chain?: VestingChainKey | string | null,
): Promise<BankrTokenInfo | null> {
  const token = tokenAddress.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(token)) return null;

  try {
    const upstream = await fetch(`${BANKR_API}/token-launches/${token}`);
    if (!upstream.ok) return null;

    const data = (await upstream.json()) as BankrLaunchResponse;
    const launch = data.launch;
    if (!launch?.tokenAddress) return null;

    const recipient = launch.feeRecipient ?? launch.deployer;
    const wallet = recipient?.walletAddress?.toLowerCase();
    if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) return null;

    return {
      tokenAddress: launch.tokenAddress,
      name: launch.tokenName ?? "",
      symbol: launch.tokenSymbol ?? "",
      imageUri: launch.imageUri,
      feeRecipient: {
        wallet,
        xUsername: recipient?.xUsername?.replace(/^@/, ""),
        xProfileImageUrl: recipient?.xProfileImageUrl,
      },
      launchUrl: bankrLaunchUrl(launch.tokenAddress, chain),
      source: "bankr.launch",
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
