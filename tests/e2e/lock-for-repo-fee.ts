/**
 * TEST-ONLY: lock a small PTK amount for an arbitrary repo into the
 * FEE suite's GitEscrowV2 (or LOCK_ESCROW when set — the recognition
 * wrong-escrow case locks into a second escrow), signed by the
 * recipient signer (Hardhat #2). Reads tests/e2e/state-fee.json.
 *   LOCK_REPO=testowner/feeproj LOCK_AMOUNT=10 [LOCK_ESCROW=0x…] \
 *     npx hardhat run … tests/e2e/lock-for-repo-fee.ts
 * Prints LOCK_TX=<hash> on the last line. Local Hardhat node only.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const repo = process.env.LOCK_REPO;
  if (!repo) throw new Error("LOCK_REPO env required (owner/name)");
  const amount = ethers.parseUnits(process.env.LOCK_AMOUNT ?? "10", 18);
  const fee = JSON.parse(fs.readFileSync(path.join(__dirname, "state-fee.json"), "utf8"));
  const escrowAddr = process.env.LOCK_ESCROW ?? fee.gitEscrow;

  const [, , recipient] = await ethers.getSigners();
  const ptk = await ethers.getContractAt("MockERC20", fee.ptk);
  const escrow = await ethers.getContractAt("GitEscrowV2", escrowAddr);

  const repoId = ethers.keccak256(ethers.toUtf8Bytes(repo));
  const mintTx = await ptk.mint(recipient.address, amount);
  await mintTx.wait();
  const approveTx = await ptk.connect(recipient).approve(escrowAddr, amount);
  await approveTx.wait();
  const lockTx = await escrow.connect(recipient).lock(repoId, fee.ptk, amount, 2, 1);
  const receipt = await lockTx.wait();
  const block = await ethers.provider.getBlock(receipt!.blockNumber);
  console.log("repo:", repo, "repoId:", repoId, "escrow:", escrowAddr, "blockTimestamp:", block?.timestamp);
  console.log(`LOCK_TX=${lockTx.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
