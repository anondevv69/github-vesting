/**
 * TEST-ONLY: accrue more claimable fees to the vault on the mock claim
 * source (models a second round of trading fees). Usage:
 *   AMOUNT=30 npx hardhat run … tests/e2e/fee-topup.ts
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-fee.json"), "utf8"));
  const amount = ethers.parseUnits(process.env.AMOUNT ?? "30", 18);
  const source = await ethers.getContractAt("MockFeeClaimSource", state.feeClaimSource);
  const tx = await source.accrue(state.feeLockVault, amount);
  await tx.wait();
  console.log(`TOPUP accrued ${process.env.AMOUNT ?? "30"} WETH to vault, tx=${tx.hash}`);
  console.log("claimable now:", (await source.claimable(state.feeLockVault)).toString());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
