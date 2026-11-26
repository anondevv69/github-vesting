/**
 * FeeStreamEscrow tranche-baseline provenance test (local Hardhat network).
 * Run: npx hardhat run tests/fee-baseline-test.ts
 *
 * Codex round-2, finding 4: a fee tranche's baseline must be bound to
 * the escrow's CURRENT counted total at lock time — the same counter
 * releaseFee vests against (knownPushCount, advanced only by oracle
 * reports). addFeeTranche now takes expectedBaseline and reverts when
 * it differs. Proves:
 *  1. A tranche locked with the CURRENT baseline (0) succeeds and is
 *     stamped baseline 0.
 *  2. The oracle reports counted pushes (releaseFee at total 2) —
 *     the authoritative counter moves to 2.
 *  3. A tranche locked with the STALE baseline (0) reverts; the vault
 *     keeps its balance (nothing half-locked).
 *  4. Retrying with the CURRENT baseline (2) succeeds and the tranche
 *     is stamped baseline 2 — it will vest only over pushes AFTER 2.
 *  5. Vault claim path: claimFees executes ledger collectFees
 *     calldata (the SDK buildClaim shape) and a non-claim selector
 *     is refused by the vault's allowlist.
 *  6. The vault restricted its own claim policy on the ledger in its
 *     constructor (the Bankr factory's contract-recipient rule).
 */
import { ethers } from "hardhat";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra !== undefined ? ` (${String(extra)})` : ""}`);
  if (!cond) failures++;
}
async function expectRevert(name: string, p: Promise<unknown>, needle?: string) {
  try {
    await p;
    check(name, false, "did not revert");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, !needle || msg.includes(needle), needle ? msg.slice(0, 140) : undefined);
  }
}

async function main() {
  const [deployer, oracle, recipient] = await ethers.getSigners();
  const repoFullName = "testowner/baselineproj";
  const repoId = ethers.keccak256(ethers.toUtf8Bytes(repoFullName));

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
  const vault = await Vault.deploy(feeEscrowAddr, wethAddr, repoId, recipient.address, sourceAddr);
  const vaultAddr = await vault.getAddress();

  // 6. Constructor claim-restriction on the ledger.
  check("vault restricted its claim policy at construction", (await source.claimRestricted(vaultAddr)) === true);

  // Fee grant: recipient names the vault, tranches vest over 2 pushes.
  await (await feeEscrow.connect(recipient).registerFeeGrant(repoId, wethAddr, vaultAddr, 2)).wait();

  // Fund the claim source; accrue 40 WETH of fees to the vault.
  await (await weth.mint(deployer.address, ethers.parseUnits("1000", 18))).wait();
  await (await weth.transfer(sourceAddr, ethers.parseUnits("1000", 18))).wait();
  await (await source.accrue(vaultAddr, ethers.parseUnits("40", 18))).wait();

  // 5a. Non-claim calldata is refused by the vault's selector allowlist.
  const transferData = weth.interface.encodeFunctionData("transfer", [recipient.address, 1n]);
  await expectRevert(
    "claimFees refuses a non-claim selector",
    vault.connect(deployer).claimFees(transferData),
    "not a claim call",
  );

  // 5b. Real claim shape: collectFees(bytes32) calldata, as the SDK's
  // buildClaim builds it — executed THROUGH the vault.
  const claimData = source.interface.encodeFunctionData("collectFees", [ethers.ZeroHash]);
  const claimed: bigint = await vault.connect(deployer).claimFees.staticCall(claimData).then(async (preview) => {
    await (await vault.connect(deployer).claimFees(claimData)).wait();
    return preview as bigint;
  });
  check("claimFees(collectFees calldata) landed 40 WETH in the vault", claimed === ethers.parseUnits("40", 18), claimed.toString());
  check("vault balance is 40 WETH after the claim", (await weth.balanceOf(vaultAddr)) === ethers.parseUnits("40", 18));

  // 1. Lock tranche 1 with the current baseline (0 counted pushes).
  await (await vault.connect(deployer).lockAccrued(0n)).wait();
  const t0 = await feeEscrow.getTranche(repoId, 0);
  check("tranche 1 stamped with baseline 0", t0.baselinePushCount === 0n && t0.amount === ethers.parseUnits("40", 18), `baseline=${t0.baselinePushCount}`);

  // 2. Oracle reports 2 counted pushes (releaseFee advances the counter).
  await (await feeEscrow.connect(oracle).releaseFee(repoId, 2)).wait();
  check("knownPushCount advanced to 2 via the oracle path", (await feeEscrow.knownPushCount(repoId)) === 2n);
  check("tranche 1 fully vested at 2 pushes (recipient has 40)", (await weth.balanceOf(recipient.address)) === ethers.parseUnits("40", 18));

  // More fees accrue + are claimed: 30 WETH sits in the vault.
  await (await source.accrue(vaultAddr, ethers.parseUnits("30", 18))).wait();
  await (await vault.connect(deployer).claimFees(claimData)).wait();

  // 3. STALE baseline (0) reverts; nothing moves.
  await expectRevert(
    "lockAccrued with a stale baseline reverts",
    vault.connect(deployer).lockAccrued(0n),
    "stale baseline",
  );
  check("vault still holds the 30 WETH after the stale attempt", (await weth.balanceOf(vaultAddr)) === ethers.parseUnits("30", 18));
  check("no second tranche was created by the stale attempt", (await feeEscrow.trancheCount(repoId)) === 1n);

  // 4. CURRENT baseline (2) succeeds; the tranche is stamped 2.
  await (await vault.connect(deployer).lockAccrued(2n)).wait();
  const t1 = await feeEscrow.getTranche(repoId, 1);
  check("tranche 2 stamped with baseline 2", t1.baselinePushCount === 2n && t1.amount === ethers.parseUnits("30", 18), `baseline=${t1.baselinePushCount}`);
  check("tranche 2 has released nothing yet", t1.released === 0n);

  console.log(`\nfee-baseline: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
