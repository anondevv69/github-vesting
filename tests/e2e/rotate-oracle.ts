/**
 * TEST-ONLY: rotate the GitEscrowV2 oracle (owner = deployer acct #0)
 * to the backup oracle (Hardhat acct #4) — the GitHub-death recovery
 * step. Reads the escrow address from state.json.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
  const signers = await ethers.getSigners();
  const owner = signers[0]!;
  const backup = signers[4]!;
  const escrow = await ethers.getContractAt("GitEscrowV2", state.gitEscrow);
  const tx = await escrow.connect(owner).setOracle(backup.address);
  await tx.wait();
  console.log(`ROTATED oracle -> ${backup.address} tx=${tx.hash}`);
  console.log("oracle now:", await escrow.oracle());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
