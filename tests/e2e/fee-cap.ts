/**
 * TEST-ONLY (run-fee-lock.sh step 37): the BACKEND half of the
 * round-4 release-cap scenario (Codex round-4, blocker 2).
 *
 * The cap grant (deploy-cap.ts) has 40 tranches of 1 WETH vesting
 * at counted total 1 — one releaseFee call can settle only 16
 * (MAX_TRANCHES_PER_RELEASE). Proves, through the real backend
 * modules (src/oracle/feeLock.ts):
 *   1. The push-path release pays exactly the capped subset
 *      (16 WETH) and reports remainingDue = 24 WETH.
 *   2. The pending-fee-release entry SURVIVES the successful tx —
 *      settlement is decided by the contract's releasableAt, not
 *      by the receipt.
 *   3. The keeper sweep drains the rest with NO new pushes
 *      (16 + 8 over two more calls) and only then clears the entry.
 *   4. The recipient's lifetime total is exactly 40 WETH, and a
 *      second sweep pays nothing extra.
 *
 * Run with FEE_STREAM_ESCROW_ADDRESS=<cap escrow> so the backend
 * config points at the cap fixture's escrow.
 */
import * as fs from "fs";
import * as path from "path";
import { createPublicClient, http, parseAbi, formatUnits, type Address } from "viem";
import { base } from "viem/chains";
import { getRedis, KEYS, saveGrant, type GrantRecord } from "../../src/lib/redis";
import { repoIdFromFullName } from "../../src/lib/repoId";
import {
  triggerFeeReleaseIfDue,
  sweepPendingFeeReleases,
  getPendingFeeRelease,
} from "../../src/oracle/feeLock";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-cap.json"), "utf8"));
  const repoId = repoIdFromFullName(state.repoFullName);
  const client = createPublicClient({ chain: base, transport: http("http://127.0.0.1:8545") });
  const bal = () =>
    client.readContract({
      address: state.weth as Address,
      abi: ERC20,
      functionName: "balanceOf",
      args: [state.recipient as Address],
    });

  const grant: GrantRecord = {
    repoId,
    repoFullName: state.repoFullName,
    platform: "github",
    recipient: state.recipient,
    token: state.weth,
    chain: "base",
    totalLocked: "0",
    totalPushesRequired: 0,
    pushesPerMilestone: 1,
    tokensPerMilestone: "0",
    verifiedPushCount: 1,
    lastPaidMilestone: 0,
    onChainTxHash: "0x",
    installationId: 777,
    feeLockVault: state.feeLockVault,
    feePushesPerTranche: 1,
    status: "active",
    streaming: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as GrantRecord;
  await saveGrant(grant);
  await getRedis().set(KEYS.pushCount(repoId), "1");

  // 1. Push-path release at count 1: capped subset only.
  const r1 = await triggerFeeReleaseIfDue(repoId, grant, 1);
  console.log(`CAP_CHECK first release: ${JSON.stringify(r1)}`);
  console.log(`CAP_CHECK recipient after first release: ${formatUnits(await bal(), 18)} WETH`);

  // 2. Pending entry survives the successful transaction.
  const pending = await getPendingFeeRelease(repoId);
  console.log(`CAP_CHECK pending after first release: ${JSON.stringify(pending)}`);

  // 3. Sweep drains with no new pushes; entry clears only at zero.
  const swept = await sweepPendingFeeReleases();
  console.log(`CAP_CHECK sweep: ${JSON.stringify(swept.map((s) => s.result))}`);
  console.log(`CAP_CHECK pending after sweep: ${JSON.stringify(await getPendingFeeRelease(repoId))}`);
  console.log(`CAP_CHECK recipient after sweep: ${formatUnits(await bal(), 18)} WETH`);

  // 4. Second sweep: nothing left, nothing extra paid.
  const swept2 = await sweepPendingFeeReleases();
  console.log(`CAP_CHECK second sweep entries: ${swept2.length}`);
  console.log(`CAP_CHECK recipient after second sweep: ${formatUnits(await bal(), 18)} WETH`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
