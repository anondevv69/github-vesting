/**
 * TEST-ONLY: after oracle rotation, the DEAD oracle key (Hardhat
 * #1 — the backend's configured signer) attempts a supply release
 * and a fee release at the current counted total. Both must
 * revert: rotation actually revoked the old key on both escrows.
 * Prints one marker per attempt. Local Hardhat node only.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-stitched.json"), "utf8"));
  const signers = await ethers.getSigners();
  const dead = signers[1]!;
  const repoId = state.repoId as string;

  const escrow = await ethers.getContractAt("GitEscrowV2", state.gitEscrow);
  try {
    await escrow.connect(dead).release.staticCall(repoId, 3);
    console.log("DEAD_ORACLE_SUPPLY_RELEASE: SUCCEEDED (unexpected)");
  } catch {
    console.log("DEAD_ORACLE_SUPPLY_RELEASE: REVERTED");
  }

  const feeEscrow = await ethers.getContractAt("FeeStreamEscrow", state.feeStreamEscrow);
  try {
    await feeEscrow.connect(dead).releaseFee.staticCall(repoId, 3);
    console.log("DEAD_ORACLE_FEE_RELEASE: SUCCEEDED (unexpected)");
  } catch {
    console.log("DEAD_ORACLE_FEE_RELEASE: REVERTED");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
