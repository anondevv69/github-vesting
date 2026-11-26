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
 *
 * Codex round-3 additions:
 *  7. registerFeeGrant is REGISTRAR-ONLY (the escrow owner): the
 *     recipient calling it reverts; the owner registers with the
 *     exact recipient/token/vault fields stored.
 *  8. registerFeeGrant validates the vault's bindings on-chain: a
 *     vault bound to a different repo, or whose launcher is not the
 *     named recipient, reverts registration.
 *  9. backendCountAtLock (blocker 3): with the on-chain counter at
 *     2 and the backend counter at 5 (fee report pending), a tranche
 *     locked with backendCountAtLock=5 is stamped baseline 5; the
 *     report landing at 5 vests NOTHING for it; push 6 vests half.
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

  // 7. registerFeeGrant is registrar-only (round-3): the recipient
  // (a non-owner) calling it reverts — first-caller-wins is gone.
  await expectRevert(
    "registerFeeGrant by a non-owner reverts",
    feeEscrow.connect(recipient).registerFeeGrant(repoId, recipient.address, wethAddr, vaultAddr, 2),
    "OwnableUnauthorizedAccount",
  );

  // 8. Binding validation: a vault bound to a DIFFERENT repo cannot
  // be registered for this repo, and a vault whose launcher is not
  // the named recipient cannot be registered either.
  const otherRepoId = ethers.keccak256(ethers.toUtf8Bytes("testowner/otherproj"));
  const VaultF = await ethers.getContractFactory("FeeLockVault");
  const wrongRepoVault = await VaultF.deploy(feeEscrowAddr, wethAddr, otherRepoId, recipient.address, sourceAddr);
  await expectRevert(
    "registerFeeGrant with a vault bound to a different repo reverts",
    feeEscrow.connect(deployer).registerFeeGrant(repoId, recipient.address, wethAddr, await wrongRepoVault.getAddress(), 2),
    "different repo",
  );
  const wrongLauncherVault = await VaultF.deploy(feeEscrowAddr, wethAddr, repoId, deployer.address, sourceAddr);
  await expectRevert(
    "registerFeeGrant with a vault whose launcher is not the recipient reverts",
    feeEscrow.connect(deployer).registerFeeGrant(repoId, recipient.address, wethAddr, await wrongLauncherVault.getAddress(), 2),
    "not the recipient",
  );

  // Fee grant: the owner/registrar registers recipient + vault,
  // tranches vest over 2 pushes.
  await (await feeEscrow.connect(deployer).registerFeeGrant(repoId, recipient.address, wethAddr, vaultAddr, 2)).wait();
  const grant0 = await feeEscrow.feeGrants(repoId);
  check(
    "registered grant stores the exact recipient/token/vault/pushesPerTranche",
    grant0.recipient === recipient.address &&
      grant0.token === wethAddr &&
      grant0.vault === vaultAddr &&
      grant0.pushesPerTranche === 2n &&
      grant0.registered === true,
  );

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

  // 1. Lock tranche 1 with the current baseline (0 counted pushes,
  // backend counter also 0).
  await (await vault.connect(deployer).lockAccrued(0n, 0n)).wait();
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
    vault.connect(deployer).lockAccrued(0n, 0n),
    "stale baseline",
  );
  check("vault still holds the 30 WETH after the stale attempt", (await weth.balanceOf(vaultAddr)) === ethers.parseUnits("30", 18));
  check("no second tranche was created by the stale attempt", (await feeEscrow.trancheCount(repoId)) === 1n);

  // 4. CURRENT baseline (2) succeeds; the tranche is stamped 2.
  await (await vault.connect(deployer).lockAccrued(2n, 2n)).wait();
  const t1 = await feeEscrow.getTranche(repoId, 1);
  check("tranche 2 stamped with baseline 2", t1.baselinePushCount === 2n && t1.amount === ethers.parseUnits("30", 18), `baseline=${t1.baselinePushCount}`);
  check("tranche 2 has released nothing yet", t1.released === 0n);

  // 9. backendCountAtLock (round-3, blocker 3) — the reviewer's
  // exact gap, at contract level: the backend has counted pushes up
  // to 5, but the fee report for them is still pending, so the
  // on-chain counter is still 2. The keeper locks a fresh 10 WETH
  // tranche with expectedBaseline=2 (correct on-chain) and
  // backendCountAtLock=5. The tranche must be stamped baseline 5.
  await (await source.accrue(vaultAddr, ethers.parseUnits("10", 18))).wait();
  await (await vault.connect(deployer).claimFees(claimData)).wait();
  await (await vault.connect(deployer).lockAccrued(2n, 5n)).wait();
  const t2 = await feeEscrow.getTranche(repoId, 2);
  check(
    "tranche 3 stamped baseline = max(on-chain 2, backend 5) = 5, backendCountAtLock recorded",
    t2.baselinePushCount === 5n && t2.backendCountAtLock === 5n && t2.amount === ethers.parseUnits("10", 18),
    `baseline=${t2.baselinePushCount} backend=${t2.backendCountAtLock}`,
  );

  // The pending report lands: oracle reports total 5. Tranche 2
  // (baseline 2) finishes vesting (+30 to the recipient); tranche 3
  // vests NOTHING — push 5 was counted BEFORE it locked.
  const balBefore5 = await weth.balanceOf(recipient.address);
  await (await feeEscrow.connect(oracle).releaseFee(repoId, 5)).wait();
  const t2after5 = await feeEscrow.getTranche(repoId, 2);
  check("report landing at 5 vests nothing for tranche 3", t2after5.released === 0n);
  check(
    "report landing at 5 completes tranche 2 (+30 WETH)",
    (await weth.balanceOf(recipient.address)) - balBefore5 === ethers.parseUnits("30", 18),
  );

  // Push 6 counts: tranche 3 vests half (1 of 2 pushes) = 5 WETH.
  await (await feeEscrow.connect(oracle).releaseFee(repoId, 6)).wait();
  const t2after6 = await feeEscrow.getTranche(repoId, 2);
  check("push 6 vests half of tranche 3 (5 WETH)", t2after6.released === ethers.parseUnits("5", 18), `released=${t2after6.released}`);

  console.log(`\nfee-baseline: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
