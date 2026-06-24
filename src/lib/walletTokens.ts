/**
 * Resolve ERC-20 tokens from wallet holdings on Base (Blockscout index).
 */

import { isAddress, type Address } from "viem";
import knownEscrow from "../../skills/bankr-vesting/known-escrow.json";

const IS_TESTNET = process.env.VITE_CHAIN === "base-sepolia";
const BLOCKSCOUT_BASE = IS_TESTNET
  ? "https://base-sepolia.blockscout.com"
  : "https://base.blockscout.com";

const BANKR_API = "https://api.bankr.bot";

export type WalletToken = {
  address: Address;
  symbol: string;
  name: string;
  balanceRaw: string;
  decimals: number;
  source: "wallet" | "fee-recipient" | "known";
};

type BlockscoutBalance = {
  token?: {
    address_hash?: string;
    symbol?: string;
    name?: string;
    decimals?: string;
  };
  value?: string;
};

function normalizeSymbol(symbol: string): string {
  return symbol.replace(/^\$+/, "").trim().toLowerCase();
}

export async function fetchFeeRecipientTokens(wallet: string): Promise<WalletToken[]> {
  try {
    const upstream = await fetch(`${BANKR_API}/public/doppler/creator-fees/${wallet}`);
    if (!upstream.ok) return [];
    const data = (await upstream.json()) as {
      tokens?: Array<{ tokenAddress: string; name?: string; symbol?: string }>;
    };
    return (data.tokens ?? [])
      .filter((t) => isAddress(t.tokenAddress))
      .map((t) => ({
        address: t.tokenAddress as Address,
        symbol: t.symbol ?? "",
        name: t.name ?? "",
        balanceRaw: "0",
        decimals: 18,
        source: "fee-recipient" as const,
      }));
  } catch {
    return [];
  }
}

export async function fetchWalletErc20Balances(wallet: Address): Promise<WalletToken[]> {
  try {
    const url = `${BLOCKSCOUT_BASE}/api/v2/addresses/${wallet}/token-balances`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return [];

    const rows = (await res.json()) as BlockscoutBalance[];
    return rows
      .filter((row) => row.token?.address_hash && row.value && row.value !== "0")
      .map((row) => ({
        address: row.token!.address_hash as Address,
        symbol: row.token!.symbol ?? "",
        name: row.token!.name ?? "",
        balanceRaw: row.value!,
        decimals: Number(row.token!.decimals ?? 18),
        source: "wallet" as const,
      }));
  } catch {
    return [];
  }
}

function knownTokens(): WalletToken[] {
  return Object.values(knownEscrow.supportedTokens).map((t) => ({
    address: t.address as Address,
    symbol: t.symbol,
    name: t.symbol,
    balanceRaw: "0",
    decimals: 18,
    source: "known" as const,
  }));
}

/** Wallet holdings + fee-recipient + known tokens, deduped by address. */
export async function listLockableTokens(wallet: Address): Promise<WalletToken[]> {
  const [walletTokens, feeTokens] = await Promise.all([
    fetchWalletErc20Balances(wallet),
    fetchFeeRecipientTokens(wallet),
  ]);

  const byAddress = new Map<string, WalletToken>();
  for (const t of [...knownTokens(), ...feeTokens, ...walletTokens]) {
    const key = t.address.toLowerCase();
    const existing = byAddress.get(key);
    if (!existing || t.source === "wallet") {
      byAddress.set(key, t);
    }
  }
  return [...byAddress.values()];
}

export async function resolveTokenForWallet(
  wallet: string,
  tokenInput: string,
): Promise<{ address: Address; symbol?: string } | { error: string; candidates?: WalletToken[] }> {
  const raw = tokenInput.trim();
  if (isAddress(raw)) return { address: raw as Address };

  const needle = normalizeSymbol(raw);
  if (!needle) {
    return { error: "token required (symbol or 0x address)" };
  }

  const tokens = await listLockableTokens(wallet as Address);

  const matches = tokens.filter((t) => {
    const sym = normalizeSymbol(t.symbol);
    const name = normalizeSymbol(t.name);
    return sym === needle || name === needle;
  });

  if (matches.length === 1) {
    return { address: matches[0]!.address, symbol: matches[0]!.symbol };
  }

  if (matches.length > 1) {
    const lines = matches.map((t) => `${t.symbol} — ${t.address}`).join("\n");
    return {
      error: `Multiple tokens match "${raw}" in your wallet — use the 0x contract address:\n${lines}`,
      candidates: matches,
    };
  }

  const holdings = tokens
    .filter((t) => t.source === "wallet" && t.symbol)
    .slice(0, 12)
    .map((t) => `${t.symbol} — ${t.address}`)
    .join("\n");

  const holdingHint = holdings
    ? `\n\nTokens in your wallet on Base:\n${holdings}`
    : "";

  return {
    error:
      `Unknown token "${raw}". Use a symbol from your wallet or a 0x contract address — any ERC-20 on Base works.${holdingHint}`,
    candidates: tokens.filter((t) => t.source === "wallet"),
  };
}
