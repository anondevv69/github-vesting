/**
 * Launch recognition evidence (Codex round-2, finding 2).
 *
 * Round 1 proved a verification token was presented BEFORE the lock
 * (ordering). That does not prove the PREPARED launch input was the
 * one actually used. This module supplies the missing evidence at
 * grant registration:
 *
 *   1. PREPARED-LAUNCH RECORD — POST /api/launch/prepare-launch stores
 *      what it prepared: the exact fee recipients (production split),
 *      the fee-lock vault, and the vault's runtime CODEHASH read
 *      on-chain at prepare time (the pin a later substitution is
 *      checked against).
 *   2. VAULT BINDING — registration re-reads the vault on-chain: it
 *      must be a contract, its codehash must equal the pinned one,
 *      and its immutable bindings (escrow destination, repoId,
 *      launcher) must match the registration's repo + recipient and
 *      the chain's configured FeeStreamEscrow.
 *   3. LAUNCH-USE EVIDENCE — registration reads the token's ACTUAL
 *      fee configuration from Bankr's contracts and compares it to
 *      the prepared recipients: factory.poolOf(token) → poolId;
 *      creator bucket = keccak256(encodePacked(poolId, "creator"))
 *      (the SDK lens's BucketIds derivation); ledger
 *      .beneficiariesOf(bucket) + .creatorShareOf(bucket, account),
 *      normalised to bps exactly as the SDK's creatorRecipientsOf
 *      does (largest entry carries the rounding remainder).
 *
 * Residue, stated precisely: the codehash pin exists only when the
 * launch went through prepare-launch (a prepared record). A
 * registration presenting a vault WITHOUT a prepared record still
 * gets the immutable-binding checks, but no codehash pin and no
 * launch-use comparison — there is no prepared input to compare
 * against. On chains with no Bankr factory/ledger configured
 * (Base Sepolia), the launch-use read is unavailable and recognition
 * that relies on it is withheld as unprovable.
 */

import {
  createPublicClient,
  http,
  parseAbi,
  keccak256,
  encodePacked,
  type Address,
} from "viem";
import { getRedis, KEYS } from "./redis";
import { getVestingChainConfig, type VestingChainKey } from "./chains";
import { normalizeRepoFullName } from "./repoId";
import type { LaunchFeeRecipient } from "./launchFeeConfig";

const VAULT_ABI = parseAbi([
  "function escrow() view returns (address)",
  "function repoId() view returns (bytes32)",
  "function launcher() view returns (address)",
]);

const FACTORY_ABI = parseAbi([
  "function poolOf(address token) view returns (bytes32 poolId, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key)",
]);

const LEDGER_ABI = parseAbi([
  "function beneficiariesOf(bytes32 bucketId) view returns (address[])",
  "function creatorShareOf(bytes32 bucketId, address account) view returns (uint256)",
]);

function publicClientFor(chain: VestingChainKey) {
  const cfg = getVestingChainConfig(chain);
  return { cfg, client: createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) }) };
}

// ─── Prepared-launch record ──────────────────────────────────────────────

export type PreparedLaunchRecord = {
  repo: string;
  wallet: string;
  chainId: number;
  /** The verification token nonce this preparation was made under. */
  verificationNonce: string;
  /** The project's FeeLockVault, or null for the platform's own
   *  launch (Gregory exception — launcher share to his raw wallet). */
  feeLockVault: string | null;
  /** Runtime codehash of the vault, read on-chain at prepare time. */
  vaultCodehash: string | null;
  /** The exact fee recipients the prepared input carries. */
  feeRecipients: LaunchFeeRecipient[];
  vestingBps: 0;
  preparedAt: string;
};

const PREPARED_LAUNCH_TTL_SEC = 30 * 24 * 60 * 60;

export async function recordPreparedLaunch(record: PreparedLaunchRecord): Promise<void> {
  await getRedis().set(
    KEYS.preparedLaunch(record.repo, record.wallet),
    JSON.stringify(record),
    "EX",
    PREPARED_LAUNCH_TTL_SEC,
  );
}

export async function getPreparedLaunch(
  repo: string,
  wallet: string,
): Promise<PreparedLaunchRecord | null> {
  const raw = await getRedis().get(
    KEYS.preparedLaunch(normalizeRepoFullName(repo), wallet.toLowerCase()),
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PreparedLaunchRecord;
  } catch {
    return null;
  }
}

// ─── Vault reads ─────────────────────────────────────────────────────────

export type VaultBinding = {
  hasCode: boolean;
  codehash: string | null;
  escrow: string | null;
  /** repoId as 64 lowercase hex chars, no 0x prefix. */
  repoId: string | null;
  launcher: string | null;
};

/** Read a vault's code + immutable bindings on-chain. Any read
 *  failure leaves the corresponding field null (unprovable), never a
 *  guessed value. */
export async function readVaultBinding(
  chain: VestingChainKey,
  vault: string,
): Promise<VaultBinding> {
  const { client } = publicClientFor(chain);
  const out: VaultBinding = { hasCode: false, codehash: null, escrow: null, repoId: null, launcher: null };
  try {
    const code = await client.getCode({ address: vault as Address });
    if (!code || code === "0x") return out;
    out.hasCode = true;
    out.codehash = keccak256(code);
  } catch {
    return out;
  }
  const read = async (functionName: "escrow" | "repoId" | "launcher") => {
    try {
      return await client.readContract({
        address: vault as Address,
        abi: VAULT_ABI,
        functionName,
      });
    } catch {
      return null;
    }
  };
  const escrow = await read("escrow");
  const repoId = await read("repoId");
  const launcher = await read("launcher");
  out.escrow = escrow ? String(escrow).toLowerCase() : null;
  out.repoId = repoId ? String(repoId).slice(2).toLowerCase() : null;
  out.launcher = launcher ? String(launcher).toLowerCase() : null;
  return out;
}

// ─── Launch-use evidence ─────────────────────────────────────────────────

/** The creator bucket id for a pool (SDK BucketIds.derivation). */
export function creatorBucketId(poolId: `0x${string}`): `0x${string}` {
  return keccak256(encodePacked(["bytes32", "string"], [poolId, "creator"]));
}

/**
 * Read a launched token's actual creator fee recipients from Bankr's
 * factory + fee ledger, normalised to bps of the creator slice (the
 * SDK's creatorRecipientsOf rounding: largest entry carries the
 * remainder so the list sums to 10000). Returns null when the read is
 * unavailable (no factory/ledger configured for the chain, the token
 * is not a launch on this factory, or any read fails) — null means
 * UNPROVABLE, and callers must treat it that way.
 */
export async function readLaunchFeeRecipients(
  chain: VestingChainKey,
  token: string,
): Promise<LaunchFeeRecipient[] | null> {
  const { cfg, client } = publicClientFor(chain);
  if (!cfg.bankrFactoryAddress || !cfg.bankrFeeLedgerAddress) return null;
  try {
    const [poolId] = await client.readContract({
      address: cfg.bankrFactoryAddress as Address,
      abi: FACTORY_ABI,
      functionName: "poolOf",
      args: [token as Address],
    });
    if (!poolId || /^0x0{64}$/.test(poolId)) return null;
    const bucketId = creatorBucketId(poolId);
    const beneficiaries = await client.readContract({
      address: cfg.bankrFeeLedgerAddress as Address,
      abi: LEDGER_ABI,
      functionName: "beneficiariesOf",
      args: [bucketId],
    });
    const entries: { recipient: Address; creatorShareWad: bigint }[] = [];
    for (const account of beneficiaries) {
      const wad = await client.readContract({
        address: cfg.bankrFeeLedgerAddress as Address,
        abi: LEDGER_ABI,
        functionName: "creatorShareOf",
        args: [bucketId, account],
      });
      if (wad > 0n) entries.push({ recipient: account, creatorShareWad: wad });
    }
    if (entries.length === 0) return null;
    const total = entries.reduce((acc, e) => acc + e.creatorShareWad, 0n);
    const list: LaunchFeeRecipient[] = entries.map((e) => ({
      recipient: e.recipient,
      shareBps: Number((e.creatorShareWad * 10_000n + total / 2n) / total),
    }));
    let largest = list[0]!;
    for (const r of list) if (r.shareBps >= largest.shareBps) largest = r;
    largest.shareBps += 10_000 - list.reduce((acc, r) => acc + r.shareBps, 0);
    return list;
  } catch {
    return null;
  }
}

/** Order-insensitive exact comparison of two recipient lists. */
export function feeRecipientsEqual(
  a: LaunchFeeRecipient[],
  b: LaunchFeeRecipient[],
): boolean {
  if (a.length !== b.length) return false;
  const norm = (list: LaunchFeeRecipient[]) =>
    list
      .map((r) => `${r.recipient.toLowerCase()}:${r.shareBps}`)
      .sort()
      .join("|");
  return norm(a) === norm(b);
}
