/**
 * Multi-chain config — Base + Robinhood Chain mainnet.
 */

import { defineChain, type Chain } from "viem";
import { base, baseSepolia } from "viem/chains";
import { env } from "./env";

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [env.ROBINHOOD_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

export type VestingChainKey = "base" | "base-sepolia" | "robinhood";

/** v1 Robinhood GitEscrow — streaming-only deploy, superseded 2026-07-10 */
const LEGACY_ROBINHOOD_ESCROW = "0xe07df659266A697804cA75a72B4af4f827036116";
const CURRENT_ROBINHOOD_ESCROW = "0x706038b47ba6d0CC69479bB286d064137B50f6Ae";

export function resolveRobinhoodEscrowAddress(configured?: string | null): string {
  const raw = (configured ?? "").trim();
  if (!raw) return CURRENT_ROBINHOOD_ESCROW;
  if (raw.toLowerCase() === LEGACY_ROBINHOOD_ESCROW.toLowerCase()) return CURRENT_ROBINHOOD_ESCROW;
  return raw;
}

export type VestingChainConfig = {
  key: VestingChainKey;
  chain: Chain;
  chainId: number;
  rpcUrl: string;
  escrowAddress: string | undefined;
  /** FeeStreamEscrow for launcher fee-lock grants (Base only for now). */
  feeStreamEscrowAddress: string | undefined;
  /** Bankr v4 launch factory (launch-record reads: poolOf). */
  bankrFactoryAddress: string | undefined;
  /** Bankr v4 fee ledger (launch-record reads: beneficiariesOf / creatorShareOf). */
  bankrFeeLedgerAddress: string | undefined;
  explorerBase: string;
  label: string;
};

export function parseVestingChain(raw?: string | null): VestingChainKey {
  const v = (raw ?? env.DEFAULT_VESTING_CHAIN ?? env.VITE_CHAIN ?? "base").trim().toLowerCase();
  if (v === "robinhood" || v === "rh" || v === "4663") return "robinhood";
  if (v === "base-sepolia" || v === "sepolia" || v === "84532") return "base-sepolia";
  return "base";
}

export function getVestingChainConfig(key: VestingChainKey): VestingChainConfig {
  switch (key) {
    case "robinhood":
      return {
        key: "robinhood",
        chain: robinhood,
        chainId: 4663,
        rpcUrl: env.ROBINHOOD_RPC_URL,
        escrowAddress: resolveRobinhoodEscrowAddress(env.GIT_ESCROW_ROBINHOOD_ADDRESS),
        feeStreamEscrowAddress: undefined,
        bankrFactoryAddress: env.BANKR_FACTORY_ADDRESS || "0x2F2FDedE5b61D9B624462FB9e138913fD2620427",
        bankrFeeLedgerAddress: env.BANKR_FEE_LEDGER_ADDRESS || "0x15e5F60817ee337f58A0B6c34b905C7C2dBC2F64",
        explorerBase: "https://robinhoodchain.blockscout.com",
        label: "Robinhood Chain",
      };
    case "base-sepolia":
      return {
        key: "base-sepolia",
        chain: baseSepolia,
        chainId: baseSepolia.id,
        rpcUrl: env.BASE_SEPOLIA_RPC_URL,
        escrowAddress: env.GIT_ESCROW_SEPOLIA_ADDRESS || undefined,
        feeStreamEscrowAddress: undefined,
        bankrFactoryAddress: undefined,
        bankrFeeLedgerAddress: undefined,
        explorerBase: "https://sepolia.basescan.org",
        label: "Base Sepolia",
      };
    default:
      return {
        key: "base",
        chain: base,
        chainId: base.id,
        rpcUrl: env.BASE_RPC_URL,
        escrowAddress: env.GIT_ESCROW_ADDRESS || undefined,
        feeStreamEscrowAddress: env.FEE_STREAM_ESCROW_ADDRESS || undefined,
        bankrFactoryAddress: env.BANKR_FACTORY_ADDRESS || "0x8cdE4Edb9A51909eef93F102f5Ce1b950769792E",
        bankrFeeLedgerAddress: env.BANKR_FEE_LEDGER_ADDRESS || "0x7C836e937831Cd5931A1ACbB9117dF9714D7d1F7",
        explorerBase: "https://basescan.org",
        label: "Base",
      };
  }
}

export function defaultVestingChain(): VestingChainKey {
  return parseVestingChain(null);
}

export function blockscoutBaseForChain(key: VestingChainKey): string {
  if (key === "robinhood") return "https://robinhoodchain.blockscout.com";
  if (key === "base-sepolia") return "https://base-sepolia.blockscout.com";
  return "https://base.blockscout.com";
}
