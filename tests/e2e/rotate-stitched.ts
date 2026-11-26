/**
 * TEST-ONLY: GitHub-death oracle rotation for the stitched suite.
 * The escrow owner (deployer, Hardhat #0) rotates the oracle on
 * BOTH escrows — GitEscrowV2 (supply) and FeeStreamEscrow (fees) —
 * to the backup verifier (Hardhat #4). After this, the backend's
 * configured oracle key (#1) can no longer release on either
 * contract. Local Hardhat node only.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-stitched.json"), "utf8"));
  const signers = await ethers.getSigners();
  const owner = signers[0]!;
  const backup = signers[4]!;
  const escrow = await ethers.getContractAt("GitEscrowV2", state.gitEscrow);
  const tx1 = await escrow.connect(owner).setOracle(backup.address);
  await tx1.wait();
  const feeEscrow = await ethers.getContractAt("FeeStreamEscrow", state.feeStreamEscrow);
  const tx2 = await feeEscrow.connect(owner).setOracle(backup.address);
  await tx2.wait();
  console.log(`ROTATED supply oracle -> ${await escrow.oracle()} tx=${tx1.hash}`);
  console.log(`ROTATED fee oracle -> ${await feeEscrow.oracle()} tx=${tx2.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
