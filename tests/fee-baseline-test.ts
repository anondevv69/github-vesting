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
 *
 * Codex round-4 (blocker 1): the backend count is no longer a bare
 * caller-supplied number — every lockAccrued carries an EIP-712
 * CountAttestation signed by the escrow's ORACLE, verified on-chain
 * (signer, escrow/repo/vault bindings, expiry, monotone nonce and
 * attested-total floors). Items 1-4 and 9 below now lock through
 * genuine oracle attestations, and a new attack battery proves:
 *  10. A self-signed (non-oracle) attestation reverts.
 *  11. Attestations bound to a different repo / vault / escrow
 *      revert.
 *  12. An expired attestation reverts.
 *  13. A replayed attestation (consumed nonce) reverts.
 *  14. A stale LOWER attested total after a higher tranche reverts
 *      (monotone floor).
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

const ATTESTATION_TYPES = {
  CountAttestation: [
    { name: "escrow", type: "address" },
    { name: "repoId", type: "bytes32" },
    { name: "vault", type: "address" },
    { name: "countedTotal", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};
let attNonce = 0;
/** Sign a CountAttestation the way the backend does (oracle key). */
async function attest(
  signer: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  escrowAddr: string,
  repoIdArg: string,
  vaultAddr: string,
  countedTotal: number,
  opts?: { nonce?: number; issuedAt?: number; expiry?: number; attEscrow?: string },
) {
  // Sign against the CHAIN's clock (block timestamps can drift
  // ahead of wall time on the in-process network).
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const att = {
    escrow: opts?.attEscrow ?? escrowAddr,
    repoId: repoIdArg,
    vault: vaultAddr,
    countedTotal: BigInt(countedTotal),
    issuedAt: BigInt(opts?.issuedAt ?? now),
    expiry: BigInt(opts?.expiry ?? now + 300),
    nonce: BigInt(opts?.nonce ?? ++attNonce),
  };
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const sig = await signer.signTypedData(
    { name: "ProofOfDev FeeStreamEscrow", version: "1", chainId, verifyingContract: escrowAddr },
    ATTESTATION_TYPES,
    att,
  );
  return { att, sig };
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
  // backend counter also 0, oracle-attested).
  const a1 = await attest(oracle, feeEscrowAddr, repoId, vaultAddr, 0);
  await (await vault.connect(deployer).lockAccrued(0n, a1.att, a1.sig)).wait();
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
  const aStale = await attest(oracle, feeEscrowAddr, repoId, vaultAddr, 0);
  await expectRevert(
    "lockAccrued with a stale baseline reverts",
    vault.connect(deployer).lockAccrued(0n, aStale.att, aStale.sig),
    "stale baseline",
  );
  check("vault still holds the 30 WETH after the stale attempt", (await weth.balanceOf(vaultAddr)) === ethers.parseUnits("30", 18));
  check("no second tranche was created by the stale attempt", (await feeEscrow.trancheCount(repoId)) === 1n);

  // 4. CURRENT baseline (2) succeeds; the tranche is stamped 2.
  const a2 = await attest(oracle, feeEscrowAddr, repoId, vaultAddr, 2);
  await (await vault.connect(deployer).lockAccrued(2n, a2.att, a2.sig)).wait();
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
  const a5 = await attest(oracle, feeEscrowAddr, repoId, vaultAddr, 5);
  await (await vault.connect(deployer).lockAccrued(2n, a5.att, a5.sig)).wait();
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

  // ── Round-4 attack battery (blocker 1) ──────────────────────────
  // On-chain counter is now 6; the highest attested total accepted
  // so far is 5. Fresh fees sit in the vault for the attempts.
  await (await source.accrue(vaultAddr, ethers.parseUnits("10", 18))).wait();
  await (await vault.connect(deployer).claimFees(claimData)).wait();

  // 10. Self-signed count: the recipient signs an attestation for
  // the true total — the escrow accepts only its ORACLE's signature.
  const forged = await attest(recipient, feeEscrowAddr, repoId, vaultAddr, 6);
  await expectRevert(
    "lockAccrued with a self-signed (non-oracle) attestation reverts",
    vault.connect(deployer).lockAccrued(6n, forged.att, forged.sig),
    "attestation signer is not the oracle",
  );

  // 11a. Attestation bound to a different repo.
  const wrongRepo = await attest(oracle, feeEscrowAddr, otherRepoId, vaultAddr, 6);
  await expectRevert(
    "attestation for a different repo reverts",
    vault.connect(deployer).lockAccrued(6n, wrongRepo.att, wrongRepo.sig),
    "different repo",
  );

  // 11b. Attestation bound to a different vault.
  const wrongVault = await attest(oracle, feeEscrowAddr, repoId, await wrongLauncherVault.getAddress(), 6);
  await expectRevert(
    "attestation for a different vault reverts",
    vault.connect(deployer).lockAccrued(6n, wrongVault.att, wrongVault.sig),
    "different vault",
  );

  // 11c. Attestation bound to a different escrow.
  const wrongEscrow = await attest(oracle, feeEscrowAddr, repoId, vaultAddr, 6, { attEscrow: wethAddr });
  await expectRevert(
    "attestation for a different escrow reverts",
    vault.connect(deployer).lockAccrued(6n, wrongEscrow.att, wrongEscrow.sig),
    "different escrow",
  );

  // 12. Expired attestation (genuine oracle signature, past expiry).
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = await attest(oracle, feeEscrowAddr, repoId, vaultAddr, 6, {
    issuedAt: nowSec - 400,
    expiry: nowSec - 10,
  });
  await expectRevert(
    "expired attestation reverts",
    vault.connect(deployer).lockAccrued(6n, expired.att, expired.sig),
    "attestation expired",
  );

  // 14. Stale LOWER attested total (3) after the floor reached 5:
  // a once-genuine attestation can never lower a later baseline.
  const staleTotal = await attest(oracle, feeEscrowAddr, repoId, vaultAddr, 3);
  await expectRevert(
    "attested total below the accepted floor reverts",
    vault.connect(deployer).lockAccrued(6n, staleTotal.att, staleTotal.sig),
    "below the accepted floor",
  );
  check("no tranche was created by any rejected attestation", (await feeEscrow.trancheCount(repoId)) === 3n);
  check("vault still holds the 10 WETH after the rejected attempts", (await weth.balanceOf(vaultAddr)) === ethers.parseUnits("10", 18));

  // Happy path under the new regime: a genuine attestation at the
  // current total (6) locks tranche 4 at baseline 6.
  const a6 = await attest(oracle, feeEscrowAddr, repoId, vaultAddr, 6);
  await (await vault.connect(deployer).lockAccrued(6n, a6.att, a6.sig)).wait();
  const t3 = await feeEscrow.getTranche(repoId, 3);
  check(
    "tranche 4 locked under a genuine attestation at baseline 6",
    t3.baselinePushCount === 6n && t3.backendCountAtLock === 6n && t3.amount === ethers.parseUnits("10", 18),
    `baseline=${t3.baselinePushCount}`,
  );

  // 13. Replay of the consumed attestation reverts (nonce spent),
  // even with fresh fees waiting and a correct baseline.
  await (await source.accrue(vaultAddr, ethers.parseUnits("5", 18))).wait();
  await (await vault.connect(deployer).claimFees(claimData)).wait();
  await expectRevert(
    "replayed attestation (consumed nonce) reverts",
    vault.connect(deployer).lockAccrued(6n, a6.att, a6.sig),
    "nonce already consumed",
  );

  console.log(`\nfee-baseline: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
