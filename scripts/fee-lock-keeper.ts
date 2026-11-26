/**
 * Fee-lock keeper: claim → lock cycle for FeeLockVaults.
 *
 * Usage:
 *   KEEPER_PRIVATE_KEY=0x… FEE_CLAIM_SOURCE=0x… \
 *     npx tsx scripts/fee-lock-keeper.ts <vaultAddress> [more vaults…]
 *
 * For each vault: build the claim calldata for the fee ledger (the
 * SDK's fees.buildClaim output in production — collectFees(bucketId)
 * against Bankr's fee ledger; FEE_CLAIM_DATA overrides with raw
 * calldata, FEE_CLAIM_BUCKET sets the bucket id) and execute it
 * THROUGH the vault (vault.claimFees(data) — claims are
 * beneficiary-originated; the vault is the beneficiary, the keeper
 * only triggers, and the vault's selector allowlist refuses anything
 * that is not a claim call). Then, if the vault holds a balance, call
 * vault.lockAccrued(expectedBaseline, attestation, signature) with
 * the on-chain baseline read from the vault's escrow (knownPushCount —
 * the authoritative on-chain counted total; the escrow reverts if
 * it moved between the read and the lock, and the keeper simply
 * retries next cycle) and an ORACLE-SIGNED CountAttestation of the
 * backend's counted total, fetched from the backend
 * (POST /api/launch/count-attestation) immediately before the lock.
 * The keeper key needs no funds relationship to the project and
 * can never receive or redirect fees: the vault's only outbound
 * path is into its escrow grant (see contracts/FeeLockVault.sol).
 *
 * ATTESTED BASELINE (Codex round-4, blocker 1): round 3 passed the
 * backend count as a bare number; the escrow could not verify it
 * and anyone can call lockAccrued directly. The bare-count path is
 * deleted on-chain — the escrow verifies the oracle's EIP-712
 * signature over (escrow, repoId, vault, countedTotal, issuedAt,
 * expiry, nonce) itself. This keeper therefore CANNOT lock without
 * a backend to issue attestations: with no BACKEND_URL/SERVER_URL
 * configured, or an unreachable/failed issuance, it defers
 * (fail-closed) rather than locking blind.
 *
 * PENDING-REPORT GATE (Codex round-3, blocker 3 — retained as a
 * courtesy layer; the attested baseline is now the load-bearing
 * fix): the backend counter can be AHEAD of the on-chain counter —
 * a push counted in the backend whose fee report is still pending
 * retry. While the backend store is configured, the keeper REFUSES
 * to touch a vault whose grant has a pending fee-release entry —
 * the gate runs before the claim leg, so a deferred cycle moves no
 * funds at all: it defers (logs, cycle stays clean) and the
 * pending-report sweep retries the report first. If the store is
 * configured but UNREACHABLE, the keeper also defers (fail-closed).
 *
 * Releases out of the escrow are NOT the keeper's job — they happen
 * on the webhook path via the oracle (src/oracle/feeLock.ts) when
 * pushes count.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeFunctionData,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getPendingFeeRelease } from "../src/oracle/feeLock";

const VAULT_ABI = parseAbi([
  "function claimFees(bytes calldata data) external returns (uint256 amount)",
  "function lockAccrued(uint256 expectedBaseline, (address escrow, bytes32 repoId, address vault, uint256 countedTotal, uint256 issuedAt, uint256 expiry, uint256 nonce) attestation, bytes signature) external returns (uint256 amount)",
  "function accrued() view returns (uint256)",
  "function escrow() view returns (address)",
  "function repoId() view returns (bytes32)",
]);

type CountAttestationWire = {
  attestation: {
    escrow: string;
    repoId: string;
    vault: string;
    countedTotal: string;
    issuedAt: string;
    expiry: string;
    nonce: string;
  };
  signature: string;
};

/** Fetch a fresh oracle CountAttestation from the backend. The
 *  attested total is the backend's own counter — the keeper cannot
 *  name a count, only ask for the signed true one. */
async function fetchCountAttestation(
  backendUrl: string,
  repoIdHex: string,
  vault: Address,
): Promise<CountAttestationWire> {
  const resp = await fetch(`${backendUrl}/api/launch/count-attestation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoId: repoIdHex, vault, chain: "base" }),
  });
  const body = (await resp.json()) as CountAttestationWire & { ok?: boolean; error?: string };
  if (!resp.ok || !body.attestation || !body.signature) {
    throw new Error(`count-attestation issuance failed (${resp.status}): ${body.error ?? "no attestation in response"}`);
  }
  return body;
}
const ESCROW_ABI = parseAbi([
  "function knownPushCount(bytes32 repoId) view returns (uint256)",
]);
const LEDGER_ABI = parseAbi([
  "function collectFees(bytes32 bucketId) external returns (uint128 nativeAmount, uint128 tokenAmount)",
]);

async function main() {
  const vaults = process.argv.slice(2) as Address[];
  if (vaults.length === 0) throw new Error("usage: fee-lock-keeper.ts <vaultAddress> […]");
  const keeperKey = process.env.KEEPER_PRIVATE_KEY ?? process.env.ORACLE_PRIVATE_KEY;
  const rpcUrl = process.env.BASE_RPC_URL ?? "http://127.0.0.1:8545";
  if (!keeperKey) throw new Error("KEEPER_PRIVATE_KEY (or ORACLE_PRIVATE_KEY) required");

  const account = privateKeyToAccount(keeperKey as `0x${string}`);
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });

  for (const vault of vaults) {
    const out: Record<string, unknown> = { vault };

    // Pending-report gate FIRST (round-3, blocker 3): read the
    // vault's escrow + repoId and, while the backend store is
    // configured, refuse to move ANY funds for this vault — no
    // claim, no lock — while a fee report for its grant is pending.
    // The sweep retries the report; the next keeper cycle proceeds.
    const escrow = await publicClient.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "escrow",
      args: [],
    });
    const repoId = await publicClient.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "repoId",
      args: [],
    });
    // repoId keys in the backend store are lowercase hex without
    // the 0x prefix (src/lib/redis.ts KEYS).
    const repoIdHex = String(repoId).slice(2).toLowerCase();
    if (process.env.REDIS_URL) {
      try {
        const pending = await getPendingFeeRelease(repoIdHex);
        if (pending) {
          out.lockDeferred =
            `pending fee release for total ${pending.pushCount} (attempts ${pending.attempts}) — ` +
            "the backend counted a push whose fee report has not landed on-chain; locking now could vest the next tranche against it. Deferring before any fund movement; the sweep retries the report first.";
          console.log(`KEEPER ${JSON.stringify(out)}`);
          continue;
        }
      } catch (err) {
        out.lockDeferred = `backend store check failed (${err instanceof Error ? err.message : String(err)}) — fail-closed, deferring rather than locking blind.`;
        console.log(`KEEPER ${JSON.stringify(out)}`);
        continue;
      }
    }

    // Attestation (round-4, blocker 1): fetch the oracle-signed
    // backend count BEFORE moving any funds — the escrow accepts
    // no other baseline evidence, so without an attestation there
    // is nothing to lock with. Fail-closed on any issuance problem.
    const backendUrl = process.env.BACKEND_URL ?? process.env.SERVER_URL;
    if (!backendUrl) {
      out.lockDeferred =
        "no BACKEND_URL/SERVER_URL configured — cannot obtain an oracle count attestation; the escrow accepts no bare counts (round-4). Deferring before any fund movement.";
      console.log(`KEEPER ${JSON.stringify(out)}`);
      continue;
    }
    let attestation: CountAttestationWire;
    try {
      attestation = await fetchCountAttestation(backendUrl, repoIdHex, vault);
    } catch (err) {
      out.lockDeferred = `count attestation unavailable (${err instanceof Error ? err.message : String(err)}) — fail-closed, deferring rather than locking blind.`;
      console.log(`KEEPER ${JSON.stringify(out)}`);
      continue;
    }
    out.attestedCountAtLock = attestation.attestation.countedTotal;
    out.attestationNonce = attestation.attestation.nonce;

    // Claim leg: execute the ledger claim calldata through the vault.
    const claimData =
      (process.env.FEE_CLAIM_DATA as `0x${string}` | undefined) ??
      encodeFunctionData({
        abi: LEDGER_ABI,
        functionName: "collectFees",
        args: [(process.env.FEE_CLAIM_BUCKET ?? `0x${"0".repeat(64)}`) as `0x${string}`],
      });
    const accruedBefore = await publicClient.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "accrued",
      args: [],
    });
    out.accruedBeforeClaim = accruedBefore.toString();
    const claimHash = await walletClient.writeContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "claimFees",
      args: [claimData],
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash: claimHash });
    out.claimTx = claimHash;

    const accrued = await publicClient.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "accrued",
      args: [],
    });
    out.accruedBeforeLock = accrued.toString();
    if (accrued > 0n) {
      // Baseline provenance: the escrow's authoritative counted total
      // at lock time. A stale read reverts on-chain (never mislocks).
      const baseline = await publicClient.readContract({
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "knownPushCount",
        args: [repoId],
      });
      out.expectedBaseline = baseline.toString();

      // The attested backend count (round-4): signed by the oracle,
      // fetched above before any funds moved. It can be AHEAD of
      // the on-chain baseline (a counted push whose fee report is
      // pending); the escrow verifies the signature and stamps the
      // tranche with max(on-chain, attested).
      const att = attestation.attestation;
      const hash = await walletClient.writeContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "lockAccrued",
        args: [
          baseline,
          {
            escrow: att.escrow as Address,
            repoId: att.repoId as `0x${string}`,
            vault: att.vault as Address,
            countedTotal: BigInt(att.countedTotal),
            issuedAt: BigInt(att.issuedAt),
            expiry: BigInt(att.expiry),
            nonce: BigInt(att.nonce),
          },
          attestation.signature as `0x${string}`,
        ],
        account,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      out.lockTx = hash;
      out.lockedAmount = accrued.toString();
    }

    console.log(`KEEPER ${JSON.stringify(out)}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
