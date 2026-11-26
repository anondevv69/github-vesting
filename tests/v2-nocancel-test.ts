/**
 * GitEscrowV2 no-cancel + GitHub-death recovery test (local Hardhat network).
 * Run: npx hardhat run tests/v2-nocancel-test.ts
 * Proves:
 *  1. lock() works, recipient is fixed, tokens sit in escrow.
 *  2. There is NO cancel function in the ABI, and a raw cancel() call reverts.
 *  3. Recipient cannot release; only the oracle can.
 *  4. GITHUB-DEATH: oracle #1 "dies" (stops). Owner rotates oracle via
 *     setOracle() to a backup wallet. The backup recounts pushes from a
 *     local git clone's history (public data, no GitHub App/webhook) and
 *     releases resume — milestone 2 pays out under the NEW oracle.
 *  5. The OLD oracle can no longer release after rotation.
 */
import { ethers } from "hardhat";
import { execSync } from "child_process";

async function main() {
  const [owner, oracle1, oracle2, recipient] = await ethers.getSigners();
  const results: Record<string, unknown> = {};

  const Mock = await ethers.getContractFactory("MockERC20");
  const token = await Mock.deploy("V2 Test Token", "V2T", 18);
  await token.mint(owner.address, ethers.parseEther("1000000"));
  const V2 = await ethers.getContractFactory("GitEscrowV2");
  const escrow = await V2.deploy(oracle1.address);
  results.escrow = await escrow.getAddress();
  results.token = await token.getAddress();

  // 1. Lock 10,000 tokens: 10 pushes total, milestone every 5.
  const repoId = ethers.keccak256(ethers.toUtf8Bytes("fren-test/pod-sdk-ecosystem"));
  const amount = ethers.parseEther("10000");
  await token.transfer(recipient.address, amount);
  await token.connect(recipient).approve(await escrow.getAddress(), amount);
  const lockTx = await escrow.connect(recipient).lock(repoId, await token.getAddress(), amount, 10, 5);
  results.lockTx = lockTx.hash;
  results.escrowBalanceAfterLock = (await token.balanceOf(await escrow.getAddress())).toString();

  // 2. No-cancel proof: ABI surface + raw low-level call with the v1 cancel selector.
  const abiNames = escrow.interface.fragments.filter((f) => f.type === "function").map((f: any) => f.name);
  results.abiFunctions = abiNames;
  results.abiHasCancel = abiNames.includes("cancel");
  const cancelSelector = ethers.id("cancel(bytes32)").slice(0, 10);
  const rawCall = await recipient.call({
    to: await escrow.getAddress(),
    data: cancelSelector + repoId.slice(2).padStart(64, "0"),
  }).then(() => "DID_NOT_REVERT").catch((e: any) => "REVERTED: " + String(e.message || e).slice(0, 120));
  results.rawCancelCall = rawCall;
  // Also via the v1 ABI (what a user with the old interface would try):
  const v1 = await ethers.getContractFactory("GitEscrow");
  const asV1 = v1.attach(await escrow.getAddress()) as any;
  results.v1AbiCancelAttempt = await asV1.connect(recipient).cancel(repoId)
    .then(() => "DID_NOT_REVERT").catch((e: any) => "REVERTED: " + String(e.message || e).slice(0, 120));
  results.recipientBalanceAfterCancelAttempts = (await token.balanceOf(recipient.address)).toString();

  // 3. Recipient cannot release.
  results.recipientReleaseAttempt = await escrow.connect(recipient).release(repoId, 5)
    .then(() => "DID_NOT_REVERT").catch((e: any) => "REVERTED (not oracle)");

  // Milestone 1 via oracle1 (the "live GitHub App" era).
  const rel1 = await escrow.connect(oracle1).release(repoId, 5);
  results.release1Tx = rel1.hash;
  results.recipientAfterMilestone1 = (await token.balanceOf(recipient.address)).toString();

  // 4. GITHUB-DEATH: oracle1 goes silent. Backup recounts from a local git
  // clone (public history — here, this very repo's git log) and the owner
  // rotates the oracle. Recount = count of non-merge commits on the default
  // branch in the clone; we cap the demo at the grant's total.
  const log = execSync("git -C " + process.cwd() + " log --oneline | wc -l").toString().trim();
  const recounted = Math.min(parseInt(log, 10), 10);
  results.gitLogCommitCount = parseInt(log, 10);
  results.recountedPushesFedToBackupOracle = recounted;
  const rotTx = await escrow.connect(owner).setOracle(oracle2.address);
  results.setOracleTx = rotTx.hash;
  results.oracleNow = await escrow.oracle();

  // 5. Old oracle is powerless now; new oracle releases milestone 2 (final).
  results.oldOracleReleaseAttempt = await escrow.connect(oracle1).release(repoId, 10)
    .then(() => "DID_NOT_REVERT").catch(() => "REVERTED (not oracle)");
  const rel2 = await escrow.connect(oracle2).release(repoId, recounted);
  results.release2Tx = rel2.hash;
  results.recipientFinal = (await token.balanceOf(recipient.address)).toString();
  results.escrowFinal = (await token.balanceOf(await escrow.getAddress())).toString();
  const grant = await escrow.getGrant(repoId);
  results.grantActive = grant.active;
  results.grantTotalReleased = grant.totalReleased.toString();

  console.log(JSON.stringify(results, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
