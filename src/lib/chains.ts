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
  /** Pre-cutover escrow on this chain: the contract existing grants
   *  were created under before `escrowAddress` was repointed (Base:
   *  the v1 production deployment). Grants that carry no stored
   *  escrow address resolve here — see resolveGrantEscrowAddress. */
  legacyEscrowAddress: string | undefined;
  /** FeeStreamEscrow for launcher fee-lock grants (Base only for now). */
  feeStreamEscrowAddress: string | undefined;
  /** Bankr v4 launch factory (launch-record reads: poolOf). */
  bankrFactoryAddress: string | undefined;
  /** Bankr v4 fee ledger (launch-record reads: beneficiariesOf / creatorShareOf). */
  bankrFeeLedgerAddress: string | undefined;
  /** The Bankr fee ledger a FeeLockVault claims from — the value its
   *  immutable claimLedger must equal at prepare-launch (round-4).
   *  Same contract as bankrFeeLedgerAddress in production. */
  bankrClaimLedgerAddress: string | undefined;
  /** Canonical WETH on this chain — the fee token every platform
   *  FeeLockVault must be bound to (prepare-launch, round-4). */
  wethAddress: string | undefined;
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
        // Robinhood was not repointed in the v2 cutover (Base is the
        // beta chain); its configured escrow IS its legacy escrow.
        legacyEscrowAddress: undefined,
        feeStreamEscrowAddress: undefined,
        bankrFactoryAddress: env.BANKR_FACTORY_ADDRESS || "0x2F2FDedE5b61D9B624462FB9e138913fD2620427",
        bankrFeeLedgerAddress: env.BANKR_FEE_LEDGER_ADDRESS || "0x15e5F60817ee337f58A0B6c34b905C7C2dBC2F64",
        bankrClaimLedgerAddress: env.BANKR_CLAIM_LEDGER_ADDRESS || env.BANKR_FEE_LEDGER_ADDRESS || "0x15e5F60817ee337f58A0B6c34b905C7C2dBC2F64",
        wethAddress: env.WETH_ADDRESS || undefined,
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
        legacyEscrowAddress: undefined,
        feeStreamEscrowAddress: undefined,
        bankrFactoryAddress: undefined,
        bankrFeeLedgerAddress: undefined,
        bankrClaimLedgerAddress: env.BANKR_CLAIM_LEDGER_ADDRESS || undefined,
        wethAddress: env.WETH_ADDRESS || "0x4200000000000000000000000000000000000006",
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
        // The pre-cutover production GitEscrow (v1) on Base — every
        // production grant created before the v2 repoint lives here.
        // Set EXPLICITLY in the production environment
        // (GIT_ESCROW_LEGACY_ADDRESS=0x3625F879C678306E92E2C27F61b9BcD8015E81A7).
        // Deliberately NO hardcoded default: a baked-in mainnet
        // address would silently redirect releases in every other
        // environment (local suites, staging) where grants were
        // created under the configured escrow. Unset → grants
        // without a stored escrow resolve to the configured escrow,
        // the pre-cutover behaviour.
        legacyEscrowAddress: env.GIT_ESCROW_LEGACY_ADDRESS || undefined,
        feeStreamEscrowAddress: env.FEE_STREAM_ESCROW_ADDRESS || undefined,
        bankrFactoryAddress: env.BANKR_FACTORY_ADDRESS || "0x8cdE4Edb9A51909eef93F102f5Ce1b950769792E",
        bankrFeeLedgerAddress: env.BANKR_FEE_LEDGER_ADDRESS || "0x7C836e937831Cd5931A1ACbB9117dF9714D7d1F7",
        bankrClaimLedgerAddress: env.BANKR_CLAIM_LEDGER_ADDRESS || env.BANKR_FEE_LEDGER_ADDRESS || "0x7C836e937831Cd5931A1ACbB9117dF9714D7d1F7",
        wethAddress: env.WETH_ADDRESS || "0x4200000000000000000000000000000000000006",
        explorerBase: "https://basescan.org",
        label: "Base",
      };
  }
}

export function defaultVestingChain(): VestingChainKey {
  return parseVestingChain(null);
}

/**
 * Per-grant escrow resolution (v1→v2 cutover, 2026-11-26).
 *
 * A grant is serviced by the escrow it was CREATED under, never by
 * whichever escrow the chain config currently points at:
 *   1. the escrow recorded on the grant at registration (the contract
 *      that emitted the grant's Locked event), when present;
 *   2. otherwise the chain's legacy (pre-cutover) escrow — every
 *      grant registered before per-grant recording existed was
 *      created under it;
 *   3. otherwise the chain's configured escrow (chains with no
 *      cutover: Robinhood, Base Sepolia — identical to the pre-cutover
 *      behaviour of resolving from chain config alone).
 */
export function resolveGrantEscrowAddress(grant: {
  chain: VestingChainKey | string;
  escrowAddress?: string | null;
}): string | undefined {
  if (grant.escrowAddress) return grant.escrowAddress;
  const cfg = getVestingChainConfig(grant.chain as VestingChainKey);
  return cfg.legacyEscrowAddress ?? cfg.escrowAddress;
}

/** Every escrow address a lock for this chain may legitimately live
 *  in: the configured (current) escrow plus the legacy escrow. Used
 *  when READING lock transactions (registration, chain detection) so
 *  a pre-cutover lock still parses after the repoint. The verified-
 *  launch stamp keeps its stricter rule — the lock must sit in the
 *  CONFIGURED escrow — enforced separately in register.ts. */
export function knownEscrowAddresses(key: VestingChainKey): string[] {
  const cfg = getVestingChainConfig(key);
  const out: string[] = [];
  if (cfg.escrowAddress) out.push(cfg.escrowAddress.toLowerCase());
  if (cfg.legacyEscrowAddress && !out.includes(cfg.legacyEscrowAddress.toLowerCase())) {
    out.push(cfg.legacyEscrowAddress.toLowerCase());
  }
  return out;
}

export function blockscoutBaseForChain(key: VestingChainKey): string {
  if (key === "robinhood") return "https://robinhoodchain.blockscout.com";
  if (key === "base-sepolia") return "https://base-sepolia.blockscout.com";
  return "https://base.blockscout.com";
}
