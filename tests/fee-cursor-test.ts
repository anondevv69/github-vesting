/**
 * FeeStreamEscrow settled-cursor test (Codex round-3, blocker 4).
 * Run: npx hardhat run tests/fee-cursor-test.ts
 *
 * releaseFee must not rescan fully-vested tranches forever: each
 * grant keeps a settledCursor (first not-fully-vested tranche) and
 * releaseFee resumes there. Proves:
 *  1. Partial vesting stops the cursor AT the partially-vested
 *     tranche (it resumes there next call, never earlier); when
 *     several tranches are mid-vesting under one report, a call
 *     pays up to the first incomplete tranche and a repeat call at
 *     the same total advances one more — lifetime amounts are
 *     exactly the tranche sums either way.
 *  2. Full vesting advances the cursor past settled tranches, and
 *     amounts paid are exactly the tranche sums (behavior identical
 *     to the old full scan).
 *  3. Long-lived grant: after 60 tranches are created and fully
 *     vested, a further releaseFee call's gasUsed is in the same
 *     order as a paying releaseFee call made when only 2 tranches
 *     existed — specifically < 2× that early call. Justification:
 *     the early call pays out 2 tranches (2 storage writes + a
 *     transfer); the late call scans ZERO tranches (cursor is at
 *     the end) and pays nothing, so its cost is the fixed call
 *     overhead — under the old full scan it would instead iterate
 *     all 60 settled tranches and cost several times the early call.
 */
import { ethers } from "hardhat";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra !== undefined ? ` (${String(extra)})` : ""}`);
  if (!cond) failures++;
}

async function main() {
  const [deployer, oracle, recipient] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20");
  const weth = await Mock.deploy("Wrapped Ether", "WETH", 18);
  const wethAddr = await weth.getAddress();
  const Source = await ethers.getContractFactory("MockFeeClaimSource");
  const source = await Source.deploy(wethAddr);
  const sourceAddr = await source.getAddress();
  const FeeEscrow = await ethers.getContractFactory("FeeStreamEscrow");
  const feeEscrow = await FeeEscrow.deploy(oracle.address);
  const feeEscrowAddr = await feeEscrow.getAddress();
  const Vault = await ethers.getContractFactory("FeeLockVault");

  await (await weth.mint(deployer.address, ethers.parseUnits("1000", 18))).wait();
  await (await weth.transfer(sourceAddr, ethers.parseUnits("1000", 18))).wait();
  const claimData = source.interface.encodeFunctionData("collectFees", [ethers.ZeroHash]);

  /** Deploy a vault + register a grant (registrar = deployer/owner). */
  async function setupGrant(repoName: string, pushesPerTranche: number) {
    const repoId = ethers.keccak256(ethers.toUtf8Bytes(repoName));
    const vault = await Vault.deploy(feeEscrowAddr, wethAddr, repoId, recipient.address, sourceAddr);
    const vaultAddr = await vault.getAddress();
    await (
      await feeEscrow
        .connect(deployer)
        .registerFeeGrant(repoId, recipient.address, wethAddr, vaultAddr, pushesPerTranche)
    ).wait();
    return { repoId, vault, vaultAddr };
  }

  /** Accrue → claim → lock one tranche of `amount` WETH at the
   *  current counters (backend count == on-chain count here). */
  async function lockTranche(
    vault: Awaited<ReturnType<typeof Vault.deploy>>,
    vaultAddr: string,
    repoId: string,
    amount: bigint,
  ) {
    await (await source.accrue(vaultAddr, amount)).wait();
    await (await vault.connect(deployer).claimFees(claimData)).wait();
    const known = await feeEscrow.knownPushCount(repoId);
    await (await vault.connect(deployer).lockAccrued(known, known)).wait();
  }

  // ── 1+2. Cursor semantics on a small grant (ppt=2, 3 tranches) ──
  // All three tranches share baseline 0, so at total 1 all three are
  // mid-vesting at once. The cursor call pays the FIRST tranche's
  // delta and stops at it (the prescribed cursor semantics — later
  // tranches' deltas for the same report pay on the next call);
  // lifetime totals stay exactly the tranche sums.
  const mid = await setupGrant("testowner/cursor-mid", 2);
  for (let i = 0; i < 3; i++) {
    await lockTranche(mid.vault, mid.vaultAddr, mid.repoId, ethers.parseUnits("1", 18));
  }
  check("mid grant has 3 tranches", (await feeEscrow.trancheCount(mid.repoId)) === 3n);
  const midBefore = await weth.balanceOf(recipient.address);
  await (await feeEscrow.connect(oracle).releaseFee(mid.repoId, 1)).wait();
  check(
    "release at 1 push pays the first tranche's vested half (0.5 WETH) and stops at it",
    (await weth.balanceOf(recipient.address)) - midBefore === ethers.parseUnits("0.5", 18),
  );
  check(
    "cursor stays at the first partially-vested tranche (0)",
    (await feeEscrow.settledCursor(mid.repoId)) === 0n,
  );
  // A repeat call at the SAME total advances one more tranche —
  // the retry path drains the shared-baseline backlog.
  await (await feeEscrow.connect(oracle).releaseFee(mid.repoId, 1)).wait();
  check(
    "repeat call at the same total pays the second tranche's half (1.0 WETH cumulative)",
    (await weth.balanceOf(recipient.address)) - midBefore === ethers.parseUnits("1", 18),
  );
  await (await feeEscrow.connect(oracle).releaseFee(mid.repoId, 2)).wait();
  check(
    "release at 2 pushes pays everything remaining (3 WETH lifetime total)",
    (await weth.balanceOf(recipient.address)) - midBefore === ethers.parseUnits("3", 18),
  );
  check(
    "cursor advanced past all settled tranches (3)",
    (await feeEscrow.settledCursor(mid.repoId)) === 3n,
  );

  // ── 3. Early-call gas: a paying release with only 2 tranches ────
  const early = await setupGrant("testowner/cursor-early", 1);
  for (let i = 0; i < 2; i++) {
    await lockTranche(early.vault, early.vaultAddr, early.repoId, ethers.parseUnits("1", 18));
  }
  const earlyTx = await feeEscrow.connect(oracle).releaseFee(early.repoId, 1);
  const earlyReceipt = await earlyTx.wait();
  const gEarly = earlyReceipt!.gasUsed;
  check("early grant paid both tranches in full", (await feeEscrow.settledCursor(early.repoId)) === 2n);

  // ── 3. Long-lived grant: 60 tranches, all vested, then re-call ──
  const long = await setupGrant("testowner/cursor-long", 1);
  for (let i = 0; i < 60; i++) {
    await lockTranche(long.vault, long.vaultAddr, long.repoId, ethers.parseUnits("0.1", 18));
  }
  check("long grant has 60 tranches", (await feeEscrow.trancheCount(long.repoId)) === 60n);
  const longBefore = await weth.balanceOf(recipient.address);
  const longTx = await feeEscrow.connect(oracle).releaseFee(long.repoId, 1);
  await longTx.wait();
  check(
    "long grant paid all 60 tranches exactly (6 WETH)",
    (await weth.balanceOf(recipient.address)) - longBefore === ethers.parseUnits("6", 18),
  );
  check("long grant cursor at the end (60)", (await feeEscrow.settledCursor(long.repoId)) === 60n);

  const finalTx = await feeEscrow.connect(oracle).releaseFee(long.repoId, 2);
  const finalReceipt = await finalTx.wait();
  const gFinal = finalReceipt!.gasUsed;
  console.log(`gas: early paying call (2 tranches) = ${gEarly}, final no-op call after 60 settled tranches = ${gFinal}`);
  check(
    "final releaseFee gasUsed < 2x the early 2-tranche paying call",
    gFinal < gEarly * 2n,
    `gFinal=${gFinal} gEarly=${gEarly}`,
  );
  check(
    "final call paid nothing further",
    (await weth.balanceOf(recipient.address)) - longBefore === ethers.parseUnits("6", 18),
  );

  console.log(`\nfee-cursor: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
