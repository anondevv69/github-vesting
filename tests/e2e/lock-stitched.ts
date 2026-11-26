/**
 * TEST-ONLY: the stitched suite's supply lock, run in the driver
 * AFTER verification + prepare-launch so registration can prove
 * ordering (verify -> prepare -> lock -> register). The recipient
 * (Hardhat #2) locks 900 PTK into GitEscrowV2 for
 * testowner/testrepo: totalPushes=3, pushesPerMilestone=1 ->
 * 300 PTK per milestone. Prints LOCK_TX=<hash> and records it in
 * the state files. Local Hardhat node only.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-stitched.json"), "utf8"));
  const [, , recipient] = await ethers.getSigners();
  const ptk = await ethers.getContractAt("MockERC20", state.ptk);
  const escrow = await ethers.getContractAt("GitEscrowV2", state.gitEscrow);
  const amount = ethers.parseUnits("900", 18);
  const repoId = state.repoId as string;

  const approveTx = await ptk.connect(recipient).approve(state.gitEscrow, amount);
  await approveTx.wait();
  const lockTx = await escrow.connect(recipient).lock(repoId, state.ptk, amount, 3, 1);
  const receipt = await lockTx.wait();
  const block = await ethers.provider.getBlock(receipt!.blockNumber);
  console.log("repo:", state.repoFullName, "repoId:", repoId, "blockTimestamp:", block?.timestamp);
  console.log(`LOCK_TX=${lockTx.hash}`);

  for (const f of ["state-stitched.json", "state.json", "state-fee.json"]) {
    const p = path.join(__dirname, f);
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    s.lockTx = lockTx.hash;
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
