/**
 * GitEscrowV3 multi-grant test (local Hardhat network).
 * Run: npx hardhat run tests/v3-multigrant-test.ts
 * Covers MULTI-LOCK-DESIGN §7 contract checklist:
 *  1. NO-CANCEL probe: no cancel/withdraw/exit in ABI; raw calls revert.
 *  2. Two grants, same repo/recipient/token, different schedules:
 *     independent milestone maths, interleaved releases, completion isolation.
 *  3. Mid-stream baseline: pushes counted before the lock vest nothing.
 *  4. reportCount is oracle-only and monotone.
 *  5. Cap: 11th concurrent active grant reverts; completion frees a slot.
 *  6. Same recipient, two tokens: independent accounting.
 *  7. Streaming + pre-funded grants coexisting on one repo.
 *  8. Amount dust: non-divisible amount pays exactly totalLocked.
 *  9. Overshoot clamp: release far past the schedule pays the remainder once.
 */
import { ethers } from "hardhat";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
async function reverts(p: Promise<unknown>): Promise<boolean> {
  try { await p; return false; } catch { return true; }
}

async function main() {
  const [owner, oracle, recipient, recipient2] = await ethers.getSigners();
  const escrowAddr = async (c: any) => await c.getAddress();

  const Mock = await ethers.getContractFactory("MockERC20");
  const tokenA = await Mock.deploy("V3 Token A", "V3A", 18);
  const tokenB = await Mock.deploy("V3 Token B", "V3B", 18);
  const V3 = await ethers.getContractFactory("GitEscrowV3");
  const escrow = await V3.deploy(oracle.address);
  const E = await escrowAddr(escrow);
  const TA = await escrowAddr(tokenA);
  const TB = await escrowAddr(tokenB);

  const repoId = ethers.keccak256(ethers.toUtf8Bytes("fren-test/multi-grant"));
  const repo2 = ethers.keccak256(ethers.toUtf8Bytes("fren-test/multi-grant-2"));

  await tokenA.mint(recipient.address, ethers.parseEther("1000000"));
  await tokenB.mint(recipient.address, ethers.parseEther("1000000"));
  await tokenA.mint(recipient2.address, ethers.parseEther("1000000"));

  // ── 1. NO-CANCEL probe ────────────────────────────────────────────────
  const abiNames = escrow.interface.fragments.filter((f) => f.type === "function").map((f: any) => f.name);
  check("abi has no cancel", !abiNames.includes("cancel"));
  check("abi has no withdraw", !abiNames.includes("withdraw"));
  check("abi has no exit", !abiNames.includes("exit"));
  for (const sig of ["cancel(bytes32)", "withdraw(bytes32)", "exit(bytes32)"]) {
    const sel = ethers.id(sig).slice(0, 10);
    const ok = await recipient.call({ to: E, data: sel + repoId.slice(2).padStart(64, "0") })
      .then(() => false).catch(() => true);
    check(`raw ${sig} reverts`, ok);
  }

  // ── 4a. reportCount: non-oracle reverts ───────────────────────────────
  check("reportCount non-oracle reverts", await reverts(escrow.connect(recipient).reportCount(repoId, 5)));
  await escrow.connect(oracle).reportCount(repoId, 0); // baseline starts at 0

  // ── 2. Two grants, same repo/recipient/token, schedules 100/1 and 50/1 ─
  const amtA = ethers.parseEther("1000"); // grant A: 100 pushes, 1/mile → 10 per push
  const amtB = ethers.parseEther("500");  // grant B: 50 pushes, 1/mile → 10 per push
  await tokenA.connect(recipient).approve(E, amtA + amtB);
  const gA = await escrow.connect(recipient).lock.staticCall(repoId, TA, amtA, 100, 1);
  await escrow.connect(recipient).lock(repoId, TA, amtA, 100, 1);
  const gB = await escrow.connect(recipient).lock.staticCall(repoId, TA, amtB, 50, 1);
  await escrow.connect(recipient).lock(repoId, TA, amtB, 50, 1);
  check("two grants distinct ids", gA !== gB);
  check("grantNonce advanced to 2", (await escrow.grantNonce(repoId)) === 2n);
  check("activeGrantCount is 2", (await escrow.activeGrantCount(repoId)) === 2n);
  check("repoGrantCount is 2", (await escrow.repoGrantCount(repoId)) === 2n);
  check("repoGrantIdAt(0) is grant A", (await escrow.repoGrantIdAt(repoId, 0)) === gA);
  check("repoGrantIdAt(1) is grant B", (await escrow.repoGrantIdAt(repoId, 1)) === gB);
  const grantA0 = await escrow.getGrant(gA);
  check("grant A baseline 0", grantA0.startPushCount === 0n);
  check("grant A tokensPerMilestone 10", grantA0.tokensPerMilestone === ethers.parseEther("10"));

  // Interleaved releases: repo total 10 → each grant earns 10 milestones.
  const balBefore = await tokenA.balanceOf(recipient.address);
  await escrow.connect(oracle).release(gA, 10);
  await escrow.connect(oracle).release(gB, 10);
  const balAfter10 = await tokenA.balanceOf(recipient.address);
  check("both grants paid 100 each at total 10", balAfter10 - balBefore === ethers.parseEther("200"),
    (balAfter10 - balBefore).toString());

  // ── 3. Mid-stream baseline: lock grant C at repo total 10 ─────────────
  // knownPushCount is now 10 (advanced by the release calls).
  check("knownPushCount advanced to 10", (await escrow.knownPushCount(repoId)) === 10n);
  const amtC = ethers.parseEther("200"); // grant C: 20 pushes, 1/mile → 10 per push
  await tokenA.connect(recipient).approve(E, amtC);
  const gC = await escrow.connect(recipient).lock.staticCall(repoId, TA, amtC, 20, 1);
  await escrow.connect(recipient).lock(repoId, TA, amtC, 20, 1);
  const grantC0 = await escrow.getGrant(gC);
  check("grant C baseline stamped 10", grantC0.startPushCount === 10n);
  check("grant C nextMilestoneAt is repo total 11", (await escrow.nextMilestoneAt(gC)) === 11n);
  // A release at repo total 10 must NOT pay grant C (nothing elapsed).
  check("release at baseline reverts (no new milestones)", await reverts(escrow.connect(oracle).release(gC, 10)));
  // At total 15: C earns 5 milestones = 50.
  const balC0 = await tokenA.balanceOf(recipient.address);
  await escrow.connect(oracle).release(gC, 15);
  check("grant C paid 50 at total 15", (await tokenA.balanceOf(recipient.address)) - balC0 === ethers.parseEther("50"));

  // ── 4b. reportCount monotone: lower total is a no-op ──────────────────
  await escrow.connect(oracle).reportCount(repoId, 3);
  check("knownPushCount never regresses", (await escrow.knownPushCount(repoId)) === 15n);

  // ── 2b. Completion isolation: drive B to completion (total 50), A continues ─
  await escrow.connect(oracle).release(gB, 50); // B: 50 milestones total → completes
  const grantB = await escrow.getGrant(gB);
  check("grant B complete + inactive", grantB.active === false && grantB.totalReleased === amtB);
  check("activeGrantCount drops to 2 (A + C)", (await escrow.activeGrantCount(repoId)) === 2n);
  check("release on completed grant reverts", await reverts(escrow.connect(oracle).release(gB, 60)));
  const grantA1 = await escrow.getGrant(gA);
  check("grant A still active, undisturbed", grantA1.active === true && grantA1.lastPaidMilestone === 10n);
  await escrow.connect(oracle).release(gA, 50);
  check("grant A paid through milestone 50", (await escrow.getGrant(gA)).lastPaidMilestone === 50n);

  // ── 9. Overshoot clamp: release A with a total far past its schedule ──
  const balA0 = await tokenA.balanceOf(recipient.address);
  await escrow.connect(oracle).release(gA, 100000);
  const grantA2 = await escrow.getGrant(gA);
  check("overshoot pays exactly the remainder and completes",
    grantA2.active === false && grantA2.totalReleased === amtA &&
    (await tokenA.balanceOf(recipient.address)) - balA0 === amtA - ethers.parseEther("500"));

  // ── 6. Same recipient, two tokens on repo2 ────────────────────────────
  const amtT = ethers.parseEther("100");
  await tokenA.connect(recipient).approve(E, amtT);
  await tokenB.connect(recipient).approve(E, amtT);
  const gTA = await escrow.connect(recipient).lock.staticCall(repo2, TA, amtT, 10, 5);
  await escrow.connect(recipient).lock(repo2, TA, amtT, 10, 5);
  const gTB = await escrow.connect(recipient).lock.staticCall(repo2, TB, amtT, 10, 5);
  await escrow.connect(recipient).lock(repo2, TB, amtT, 10, 5);
  check("two-token grants distinct", gTA !== gTB);
  await escrow.connect(oracle).release(gTA, 5);
  check("token A grant released, token B untouched",
    (await escrow.getGrant(gTA)).totalReleased === ethers.parseEther("50") &&
    (await escrow.getGrant(gTB)).totalReleased === 0n);
  check("escrow holds token B in full", (await tokenB.balanceOf(E)) === amtT);

  // ── 7. Streaming + pre-funded coexisting on repo2 ─────────────────────
  const amtS = ethers.parseEther("100");
  await tokenA.connect(recipient).approve(E, amtS); // allowance for streaming lock + later pulls
  const gS = await escrow.connect(recipient).lockAllowance.staticCall(repo2, TA, amtS, 10, 5);
  await escrow.connect(recipient).lockAllowance(repo2, TA, amtS, 10, 5);
  const grantS = await escrow.getGrant(gS);
  check("streaming grant recorded as streaming", grantS.streaming === true);
  // Streaming grant was locked after repo2's count reached 5, so its
  // baseline is 5; the next milestone lands at repo total 10.
  check("streaming grant baseline is 5 (locked mid-stream)", grantS.startPushCount === 5n);
  // Streaming release pulls from the recipient through the oracle and forwards.
  const balS0 = await tokenA.balanceOf(recipient.address);
  await escrow.connect(oracle).release(gS, 10);
  check("streaming release nets zero wallet change (pull + forward)",
    (await tokenA.balanceOf(recipient.address)) === balS0);
  check("streaming grant totalReleased advanced", (await escrow.getGrant(gS)).totalReleased === ethers.parseEther("50"));

  // ── 8. Dust: amount 100 wei over 3 milestones ─────────────────────────
  const repo3 = ethers.keccak256(ethers.toUtf8Bytes("fren-test/dust"));
  await tokenA.mint(recipient2.address, 1000n);
  await tokenA.connect(recipient2).approve(E, 100n);
  const gD = await escrow.connect(recipient2).lock.staticCall(repo3, TA, 100n, 3, 1);
  await escrow.connect(recipient2).lock(repo3, TA, 100n, 3, 1);
  await escrow.connect(oracle).release(gD, 1);
  await escrow.connect(oracle).release(gD, 2);
  const balD0 = await tokenA.balanceOf(recipient2.address);
  await escrow.connect(oracle).release(gD, 3);
  const grantD = await escrow.getGrant(gD);
  check("dust grant pays exactly totalLocked over its life",
    grantD.totalReleased === 100n && grantD.active === false &&
    (await tokenA.balanceOf(recipient2.address)) - balD0 === 34n); // 33 + 33 + 34 sweep

  // ── 5. Cap: 10 active grants max on repo3 ─────────────────────────────
  const repo4 = ethers.keccak256(ethers.toUtf8Bytes("fren-test/cap"));
  await tokenA.mint(recipient2.address, ethers.parseEther("1000"));
  await tokenA.connect(recipient2).approve(E, ethers.parseEther("1000"));
  for (let i = 0; i < 10; i++) {
    await escrow.connect(recipient2).lock(repo4, TA, ethers.parseEther("10"), 10, 5);
  }
  check("10 active grants recorded", (await escrow.activeGrantCount(repo4)) === 10n);
  check("11th concurrent lock reverts (cap)",
    await reverts(escrow.connect(recipient2).lock(repo4, TA, ethers.parseEther("10"), 10, 5)));
  // Complete one grant → a slot frees → a new lock succeeds.
  const firstId = await escrow.repoGrantIdAt(repo4, 0);
  await escrow.connect(oracle).release(firstId, 10);
  check("completed grant frees its cap slot", (await escrow.activeGrantCount(repo4)) === 9n);
  const okNew = await escrow.connect(recipient2).lock(repo4, TA, ethers.parseEther("10"), 10, 5)
    .then(() => true).catch(() => false);
  check("new lock succeeds after a completion", okNew);

  // ── Validation carry-overs ────────────────────────────────────────────
  check("uneven schedule reverts", await reverts(
    escrow.connect(recipient2).lock(repo3, TA, 100n, 10, 3)));
  check("non-oracle release reverts", await reverts(escrow.connect(recipient).release(gC, 20)));
  check("oracle rotation works", await (async () => {
    await escrow.connect(owner).setOracle(owner.address);
    return (await escrow.oracle()) === owner.address;
  })());

  console.log(`\nV3 MULTIGRANT: ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
