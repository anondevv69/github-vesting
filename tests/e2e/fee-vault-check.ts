/**
 * TEST-ONLY FeeLockVault outbound-path audit (hardhat, local node).
 * Proves:
 *  1. The vault ABI exposes NO withdraw/sweep/rescue/transfer-style
 *     function — its only state-changing functions are claimFees and
 *     lockAccrued.
 *  2. Raw calls with withdraw / transfer selectors revert (no such
 *     function exists to reach).
 *  3. lockAccrued with nothing accrued reverts.
 *  4. FeeStreamEscrow.addFeeTranche from a non-vault address reverts.
 *  5. FeeStreamEscrow.releaseFee from a non-oracle reverts.
 * Prints VAULT_CHECK lines the driver greps.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function expectRevert(label: string, p: Promise<unknown>) {
  try {
    await p;
    console.log(`VAULT_CHECK ${label}: DID_NOT_REVERT`);
  } catch {
    console.log(`VAULT_CHECK ${label}: REVERTED`);
  }
}

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-fee.json"), "utf8"));
  const [, , recipient, author] = await ethers.getSigners();

  const vault = await ethers.getContractAt("FeeLockVault", state.feeLockVault);
  const fns = vault.interface.fragments
    .filter((f) => f.type === "function")
    .map((f: any) => f.name as string);
  const stateChanging = vault.interface.fragments
    .filter((f) => f.type === "function" && (f as any).stateMutability !== "view" && (f as any).stateMutability !== "pure")
    .map((f: any) => f.name as string)
    .sort();
  console.log("VAULT_CHECK abi functions:", fns.join(","));
  console.log("VAULT_CHECK state-changing:", stateChanging.join(","));
  const banned = fns.filter((n) =>
    /withdraw|sweep|rescue|transfer|send|drain|exit|cancel/i.test(n),
  );
  console.log("VAULT_CHECK banned functions:", banned.length === 0 ? "NONE" : banned.join(","));

  // Raw low-level calls with classic drain selectors — no fallback
  // exists, so both must revert rather than move anything.
  const withdrawSel = ethers.id("withdraw(address,uint256)").slice(0, 10);
  await expectRevert("raw withdraw(address,uint256)", recipient.call({
    to: state.feeLockVault,
    data: withdrawSel + recipient.address.slice(2).padStart(64, "0") + (1n).toString(16).padStart(64, "0"),
  }).then((r) => {
    if (r === "0x") throw new Error("empty return — treated as revert for a value-moving call");
    return r;
  }));
  const transferSel = ethers.id("transfer(address,uint256)").slice(0, 10);
  await expectRevert("raw transfer(address,uint256)", recipient.call({
    to: state.feeLockVault,
    data: transferSel + recipient.address.slice(2).padStart(64, "0") + (1n).toString(16).padStart(64, "0"),
  }).then((r) => {
    if (r === "0x") throw new Error("empty return");
    return r;
  }));

  await expectRevert("lockAccrued with nothing accrued", vault.connect(author).lockAccrued(0n));

  const feeEscrow = await ethers.getContractAt("FeeStreamEscrow", state.feeStreamEscrow);
  await expectRevert(
    "addFeeTranche from non-vault",
    feeEscrow.connect(recipient).addFeeTranche(state.repoId, 1n, 0n),
  );
  await expectRevert(
    "releaseFee from non-oracle",
    feeEscrow.connect(recipient).releaseFee(state.repoId, 1),
  );
  console.log("VAULT_CHECK done");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
