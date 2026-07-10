/**
 * Frontend chain config — must match backend VestingChainKey.
 */

import { defineChain, type Chain } from "viem";
import { base, baseSepolia } from "viem/chains";

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        import.meta.env.VITE_ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
      ],
    },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

export type VestingChainKey = "base" | "base-sepolia" | "robinhood";

const LEGACY_ROBINHOOD_ESCROW = "0xe07df659266A697804cA75a72B4af4f827036116";
const CURRENT_ROBINHOOD_ESCROW = "0x706038b47ba6d0CC69479bB286d064137B50f6Ae";

function resolveRobinhoodEscrowAddress(configured?: string | null): `0x${string}` {
  const raw = (configured ?? "").trim();
  if (!raw) return CURRENT_ROBINHOOD_ESCROW as `0x${string}`;
  if (raw.toLowerCase() === LEGACY_ROBINHOOD_ESCROW.toLowerCase()) {
    return CURRENT_ROBINHOOD_ESCROW as `0x${string}`;
  }
  return raw as `0x${string}`;
}

export function parseVestingChain(raw?: string | null): VestingChainKey {
  const v = (raw ?? import.meta.env.VITE_CHAIN ?? "base").trim().toLowerCase();
  if (v === "robinhood" || v === "rh" || v === "4663") return "robinhood";
  if (v === "base-sepolia" || v === "sepolia") return "base-sepolia";
  return "base";
}

export type FrontendChainConfig = {
  key: VestingChainKey;
  chain: Chain;
  rpcUrl: string;
  escrowAddress: `0x${string}` | undefined;
  explorerBase: string;
  label: string;
};

export function getFrontendChainConfig(key: VestingChainKey): FrontendChainConfig {
  switch (key) {
    case "robinhood":
      return {
        key: "robinhood",
        chain: robinhood,
        rpcUrl:
          import.meta.env.VITE_ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
        escrowAddress: resolveRobinhoodEscrowAddress(
          import.meta.env.VITE_GIT_ESCROW_ROBINHOOD_ADDRESS,
        ),
        explorerBase: "https://robinhoodchain.blockscout.com",
        label: "Robinhood Chain",
      };
    case "base-sepolia":
      return {
        key: "base-sepolia",
        chain: baseSepolia,
        rpcUrl: import.meta.env.VITE_BASE_RPC_URL ?? "https://sepolia.base.org",
        escrowAddress: import.meta.env.VITE_GIT_ESCROW_ADDRESS as `0x${string}` | undefined,
        explorerBase: "https://sepolia.basescan.org",
        label: "Base Sepolia",
      };
    default:
      return {
        key: "base",
        chain: base,
        rpcUrl: import.meta.env.VITE_BASE_RPC_URL ?? "https://mainnet.base.org",
        escrowAddress: import.meta.env.VITE_GIT_ESCROW_ADDRESS as `0x${string}` | undefined,
        explorerBase: "https://basescan.org",
        label: "Base",
      };
  }
}

export function explorerTxUrl(chainKey: VestingChainKey, txHash: string): string {
  const cfg = getFrontendChainConfig(chainKey);
  return `${cfg.explorerBase}/tx/${txHash}`;
}

export function explorerAddressUrl(chainKey: VestingChainKey, address: string): string {
  const cfg = getFrontendChainConfig(chainKey);
  return `${cfg.explorerBase}/address/${address}`;
}

export function explorerForGrantChain(chain?: string): string {
  return getFrontendChainConfig(parseVestingChain(chain)).explorerBase;
}

export function resolveCreatePageChain(searchParams: URLSearchParams): VestingChainKey {
  const fromQuery = searchParams.get("chain");
  if (fromQuery) return parseVestingChain(fromQuery);
  return parseVestingChain(import.meta.env.VITE_CHAIN);
}
