/**
 * TEST-ONLY: the recipient attempts a v1-style cancel() against
 * GitEscrowV2 (the NO-CANCEL rule). V2 has no cancel in its ABI;
 * calling through the v1 interface must revert. Same approach as
 * tests/v2-nocancel-test.ts. Local Hardhat node only.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-stitched.json"), "utf8"));
  const signers = await ethers.getSigners();
  const recipient = signers[2]!;
  const v1View = await ethers.getContractAt("GitEscrow", state.gitEscrow);
  try {
    await v1View.connect(recipient).cancel.staticCall(state.repoId);
    console.log("CANCEL_ATTEMPT: SUCCEEDED (unexpected)");
  } catch {
    console.log("CANCEL_ATTEMPT: REVERTED");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
