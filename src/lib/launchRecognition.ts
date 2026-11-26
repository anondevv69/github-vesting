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
 *      the fee-lock vault, the canonical vault-implementation hash
 *      (below), and the verification lineage (issuing login, token
 *      nonce, token issued-at). Round 3: verified recognition
 *      REQUIRES this record — no prepared record, no stamp (an
 *      ordinary unstamped registration remains available), and a
 *      failed record lookup fails closed, never "no record".
 *   2. VAULT BINDING + IDENTITY — registration re-reads the vault
 *      on-chain: it must be a contract, its implementation must be
 *      the ONE approved FeeLockVault implementation (canonical
 *      masked-template hash, below — a pin of an arbitrary supplied
 *      contract's hash proves continuity, not identity, and is no
 *      longer accepted), and its immutable bindings (escrow
 *      destination, repoId, launcher) must match the registration's
 *      repo + recipient and the chain's configured FeeStreamEscrow.
 *   3. LAUNCH-USE EVIDENCE — registration reads the token's ACTUAL
 *      fee configuration from Bankr's contracts and compares it to
 *      the prepared recipients: factory.poolOf(token) → poolId;
 *      creator bucket = keccak256(encodePacked(poolId, "creator"))
 *      (the SDK lens's BucketIds derivation); ledger
 *      .beneficiariesOf(bucket) + .creatorShareOf(bucket, account),
 *      normalised to bps exactly as the SDK's creatorRecipientsOf
 *      does (largest entry carries the rounding remainder).
 *
 * Residue, stated precisely: on chains with no Bankr factory/ledger
 * configured (Base Sepolia), the launch-use read is unavailable and
 * recognition that relies on it is withheld as unprovable. The
 * canonical-implementation check identifies the vault's CODE (with
 * immutable slots masked out — see below); the immutable VALUES
 * embedded in those slots are constrained separately by the binding
 * checks (escrow / repoId / launcher / feeToken are all read back
 * and compared). Round 4 closed the last un-compared immutable at
 * the PREPARE step: prepare-launch now validates ALL five bindings
 * (repo, launcher, escrow, fee token, AND the Bankr claim ledger)
 * plus the registered fee grant before returning a launch input —
 * see handlePrepareLaunch in src/api/launchVerify.ts. Registration
 * remains the second line of defence.
 */

import {
  createPublicClient,
  http,
  parseAbi,
  keccak256,
  encodePacked,
  type Address,
  type Hex,
} from "viem";
import { getRedis, KEYS } from "./redis";
import { env } from "./env";
import { getVestingChainConfig, type VestingChainKey } from "./chains";
import { normalizeRepoFullName } from "./repoId";
import type { LaunchFeeRecipient } from "./launchFeeConfig";

const VAULT_ABI = parseAbi([
  "function escrow() view returns (address)",
  "function repoId() view returns (bytes32)",
  "function launcher() view returns (address)",
  "function feeToken() view returns (address)",
  "function claimLedger() view returns (address)",
]);

// ─── Canonical vault implementation (Codex round-3, blocker 2) ──────────
//
// There is ONE approved FeeLockVault implementation. A vault instance's
// raw runtime codehash can never serve as its identity: the contract's
// immutables (escrow, feeToken, repoId, launcher, claimLedger) are
// embedded in the deployed code, so every project's vault has a
// DIFFERENT raw hash. Identity is therefore the MASKED TEMPLATE hash:
// zero the immutable slots (offsets from the compiler's
// immutableReferences for contracts/FeeLockVault.sol) and hash what
// remains — the executable code, which is identical for every genuine
// instance and different for any other contract.
//
// The template parameters below are computed from the compiled
// artifact of the FeeLockVault source in this repo and are guarded by
// tests/vault-impl-test.ts, which recomputes them from the artifact
// and fails if the contract source has drifted from the constant —
// updating the implementation means updating this constant in the
// same commit, deliberately. APPROVED_FEE_LOCK_VAULT_CODEHASH (env)
// overrides the expected hash for deployments that pin it externally;
// the masking offsets/length stay those of this template.
export const APPROVED_VAULT_TEMPLATE = {
  byteLength: 2891,
  immutableOffsets: [
    [146, 32], [214, 32], [253, 32], [325, 32], [391, 32],
    [456, 32], [671, 32], [705, 32], [764, 32], [809, 32],
    [1021, 32], [1408, 32], [1530, 32], [1693, 32], [1828, 32],
  ] as Array<[number, number]>,
  /** keccak256 of the artifact's deployedBytecode with the immutable
   *  slots above zeroed (the template already carries zeroes there).
   *  Regenerated in the round-4 pass (lockAccrued now passes an
   *  oracle-signed CountAttestation through to the escrow). */
  codehash: "0x81f3375b5edec3e6b00d9a07fda53a954156a2a6de2320b5a0bd1a70d7032c2b",
} as const;

/** The expected masked-template hash for an approved vault. */
export function canonicalVaultCodehash(): string {
  const override = env.APPROVED_FEE_LOCK_VAULT_CODEHASH?.trim().toLowerCase();
  return override ? override : APPROVED_VAULT_TEMPLATE.codehash;
}

/**
 * The implementation hash of a deployed contract's runtime code:
 * immutable slots zeroed, then keccak256. A contract whose code
 * length differs from the template cannot be the approved
 * implementation; its raw hash is returned (which never equals the
 * canonical hash), so callers can compare uniformly.
 */
export function vaultImplCodehash(code: Hex): string {
  const raw = code.startsWith("0x") ? code.slice(2) : code;
  const bytes = Buffer.from(raw, "hex");
  if (bytes.length !== APPROVED_VAULT_TEMPLATE.byteLength) {
    return keccak256(code);
  }
  for (const [start, length] of APPROVED_VAULT_TEMPLATE.immutableOffsets) {
    bytes.fill(0, start, start + length);
  }
  return keccak256(`0x${bytes.toString("hex")}` as Hex);
}

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
  /** The GitHub login the preparing verification was issued to. */
  githubLogin: string;
  /** The verification token nonce this preparation was made under. */
  verificationNonce: string;
  /** Issued-at (unix seconds) of the verification token this
   *  preparation was made under — the lineage root for the
   *  token-expiry path: a later registration may present a FRESH
   *  token (new nonce) whose issuance chains to the same
   *  login/repo/wallet/chain with iat >= this value, and ordering
   *  is then judged against THIS time, not the fresh token's. */
  verificationIat: number;
  /** The project's FeeLockVault, or null for the platform's own
   *  launch (Gregory exception — launcher share to his raw wallet). */
  feeLockVault: string | null;
  /** The canonical vault-implementation hash (masked template —
   *  see above). Prepare-launch refuses a vault whose implementation
   *  hash differs, so a stored record always carries this value. */
  vaultCodehash: string | null;
  /** The exact fee recipients the prepared input carries. */
  feeRecipients: LaunchFeeRecipient[];
  vestingBps: 0;
  /** The fee grant's on-chain pushesPerTranche, verified at
   *  prepare time against the registered grant (round-4). */
  feePushesPerTranche?: number;
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
  /** Raw runtime codehash (per-instance — immutables are embedded,
   *  so this differs per project; diagnostic only). */
  codehash: string | null;
  /** Masked-template implementation hash — comparable against
   *  canonicalVaultCodehash() to establish the implementation. */
  implCodehash: string | null;
  escrow: string | null;
  /** repoId as 64 lowercase hex chars, no 0x prefix. */
  repoId: string | null;
  launcher: string | null;
  feeToken: string | null;
  claimLedger: string | null;
};

/** Read a vault's code + immutable bindings on-chain. Any read
 *  failure leaves the corresponding field null (unprovable), never a
 *  guessed value. */
export async function readVaultBinding(
  chain: VestingChainKey,
  vault: string,
): Promise<VaultBinding> {
  const { client } = publicClientFor(chain);
  const out: VaultBinding = {
    hasCode: false,
    codehash: null,
    implCodehash: null,
    escrow: null,
    repoId: null,
    launcher: null,
    feeToken: null,
    claimLedger: null,
  };
  try {
    const code = await client.getCode({ address: vault as Address });
    if (!code || code === "0x") return out;
    out.hasCode = true;
    out.codehash = keccak256(code);
    out.implCodehash = vaultImplCodehash(code);
  } catch {
    return out;
  }
  const read = async (functionName: "escrow" | "repoId" | "launcher" | "feeToken" | "claimLedger") => {
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
  const feeToken = await read("feeToken");
  const claimLedger = await read("claimLedger");
  out.escrow = escrow ? String(escrow).toLowerCase() : null;
  out.repoId = repoId ? String(repoId).slice(2).toLowerCase() : null;
  out.launcher = launcher ? String(launcher).toLowerCase() : null;
  out.feeToken = feeToken ? String(feeToken).toLowerCase() : null;
  out.claimLedger = claimLedger ? String(claimLedger).toLowerCase() : null;
  return out;
}

// ─── Fee-grant read (Codex round-4, blocker 3) ──────────────────────────

const FEE_GRANT_ABI = parseAbi([
  "function feeGrants(bytes32 repoId) view returns (address recipient, address token, address vault, uint256 pushesPerTranche, uint256 totalFeeLocked, uint256 totalFeeReleased, uint256 settledCursor, bool registered)",
]);

export type FeeGrantOnChain = {
  recipient: string;
  token: string;
  vault: string;
  pushesPerTranche: number;
  registered: boolean;
};

/**
 * Read a repo's registered fee grant from the chain's configured
 * FeeStreamEscrow. Returns null when no escrow is configured or the
 * read fails (unprovable — callers that require the grant must
 * refuse). Prepare-launch uses this to prove the registrar has
 * ALREADY registered the matching fee grant before any launch
 * input is returned: deploy vault → registrar registers grant →
 * prepare verifies grant + bindings → input.
 */
export async function readFeeGrant(
  chain: VestingChainKey,
  repoIdHex: string,
): Promise<FeeGrantOnChain | null> {
  const { cfg, client } = publicClientFor(chain);
  if (!cfg.feeStreamEscrowAddress) return null;
  try {
    const g = await client.readContract({
      address: cfg.feeStreamEscrowAddress as Address,
      abi: FEE_GRANT_ABI,
      functionName: "feeGrants",
      args: [`0x${repoIdHex.replace(/^0x/, "")}` as Hex],
    });
    return {
      recipient: String(g[0]).toLowerCase(),
      token: String(g[1]).toLowerCase(),
      vault: String(g[2]).toLowerCase(),
      pushesPerTranche: Number(g[3]),
      registered: g[7] === true,
    };
  } catch {
    return null;
  }
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
