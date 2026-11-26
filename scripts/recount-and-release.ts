/**
 * Backup-verifier recovery: recount + release (GitHub-death path).
 *
 * Usage:
 *   BACKUP_ORACLE_PRIVATE_KEY=0x… GIT_ESCROW_ADDRESS=0x… \
 *     npx tsx scripts/recount-and-release.ts <owner/repo>
 *
 * What it does, in order:
 *   1. Recounts the repo's eligible pushes from the backend's recorded
 *      push log, replaying the real verifier rules
 *      (src/lib/recount.ts) — NOT a git-log commit count.
 *   2. Prints the recount next to the backend's live counter; they
 *      must agree for the same history.
 *   3. Calls GitEscrow.release(repoId, recountedTotal) signed by the
 *      BACKUP oracle key — i.e. this runs AFTER the escrow owner has
 *      rotated the oracle (setOracle) to the backup verifier. The
 *      release pays exactly the milestones the recount backs, no more:
 *      the contract itself caps payouts at the grant's schedule and
 *      refuses a second payment for the same milestone.
 *
 * Recovery dependencies (documented in report §7/§14): the escrow
 * owner must rotate the oracle, and the push log must be retained.
 */
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { recountEligiblePushes } from "../src/lib/recount";
import { repoIdFromFullName, repoIdToBytes32 } from "../src/lib/repoId";
import { BUILDER_DATA_SUFFIX } from "../src/lib/builderCode";

const ESCROW_ABI = parseAbi([
  "function release(bytes32 repoId, uint256 totalVerifiedPushes) external",
  "event Released(bytes32 indexed repoId, address indexed recipient, uint256 amount, uint256 pushMilestone, uint256 totalReleasedSoFar)",
]);

async function main() {
  const repo = process.argv[2];
  if (!repo) throw new Error("usage: recount-and-release.ts <owner/repo>");
  const backupKey = process.env.BACKUP_ORACLE_PRIVATE_KEY ?? process.env.ORACLE_PRIVATE_KEY;
  const escrowAddress = process.env.GIT_ESCROW_ADDRESS;
  const rpcUrl = process.env.BASE_RPC_URL ?? "http://127.0.0.1:8545";
  if (!backupKey) throw new Error("BACKUP_ORACLE_PRIVATE_KEY (or ORACLE_PRIVATE_KEY) required");
  if (!escrowAddress) throw new Error("GIT_ESCROW_ADDRESS required");

  const repoId = repoIdFromFullName(repo);
  const recount = await recountEligiblePushes(repoId);
  console.log(
    `RECOUNT repo=${repo} entries=${recount.entriesExamined} recounted=${recount.recountedCount} recorded=${recount.recordedCount} status=${recount.status} checkpointUsed=${recount.checkpointUsed}`,
  );
  for (const d of recount.decisions) {
    console.log(`  ${d.counted ? "COUNT" : "skip "} ${d.sha.slice(0, 10)} — ${d.reason}`);
  }
  if (recount.status !== "certified" || recount.recountedCount === null) {
    // Codex round-2: incomplete history without a covering checkpoint
    // is REFUSED, never estimated. No release is attempted.
    console.log(
      "RECOUNT_INCOMPLETE: the recorded history does not explain the live counter and no checkpoint covers the gap — refusing to certify or release",
    );
    console.log(
      JSON.stringify({
        repo,
        recountedCount: null,
        recordedCount: recount.recordedCount,
        status: recount.status,
        releaseTx: null,
      }),
    );
    process.exit(1);
  }
  if (recount.recountedCount !== recount.recordedCount) {
    console.log("RECOUNT_MISMATCH: recount does not equal the recorded counter — releasing against the recount only");
  }

  const account = privateKeyToAccount(backupKey as `0x${string}`);
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
    dataSuffix: BUILDER_DATA_SUFFIX,
  });

  let releaseTx: Hash | null = null;
  try {
    releaseTx = await walletClient.writeContract({
      address: escrowAddress as Address,
      abi: ESCROW_ABI,
      functionName: "release",
      args: [repoIdToBytes32(repoId), BigInt(recount.recountedCount)],
      account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: releaseTx });
    console.log(`RELEASE tx=${releaseTx} status=${receipt.status}`);
  } catch (err) {
    // A release with no new milestone reverts on-chain ("no new
    // milestones") — that is a valid end state when the recount backs
    // nothing beyond what was already paid.
    console.log(`RELEASE skipped/failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }

  console.log(
    JSON.stringify({
      repo,
      recountedCount: recount.recountedCount,
      recordedCount: recount.recordedCount,
      equal: recount.recountedCount === recount.recordedCount,
      releaseTx,
    }),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
