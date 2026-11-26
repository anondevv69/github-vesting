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
 * vault.lockAccrued(expectedBaseline) with the baseline read from the
 * vault's escrow (knownPushCount — the authoritative counted total;
 * the escrow reverts if it moved between the read and the lock, and
 * the keeper simply retries next cycle). The keeper key needs no
 * funds relationship to the project and can never receive or
 * redirect fees: the vault's only outbound path is into its escrow
 * grant (see contracts/FeeLockVault.sol).
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

const VAULT_ABI = parseAbi([
  "function claimFees(bytes calldata data) external returns (uint256 amount)",
  "function lockAccrued(uint256 expectedBaseline) external returns (uint256 amount)",
  "function accrued() view returns (uint256)",
  "function escrow() view returns (address)",
  "function repoId() view returns (bytes32)",
]);
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
      const baseline = await publicClient.readContract({
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "knownPushCount",
        args: [repoId],
      });
      out.expectedBaseline = baseline.toString();
      const hash = await walletClient.writeContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "lockAccrued",
        args: [baseline],
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
