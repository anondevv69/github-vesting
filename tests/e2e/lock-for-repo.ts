/**
 * TEST-ONLY: lock a small PTK amount into the E2E GitEscrow for an
 * arbitrary repo name, signed by the recipient signer (Hardhat #2).
 * Used by run-launch-gate.sh to create lock transactions at controlled
 * times relative to verification-token issuance (ordering test):
 *   LOCK_REPO=testauthor/orderrepo LOCK_AMOUNT=10 \
 *     npx hardhat run --config hardhat.local.config.ts \
 *       --network localhost tests/e2e/lock-for-repo.ts
 * Prints LOCK_TX=<hash> on the last line. Local Hardhat node only.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const repo = process.env.LOCK_REPO;
  if (!repo) throw new Error("LOCK_REPO env required (owner/name)");
  const amount = ethers.parseUnits(process.env.LOCK_AMOUNT ?? "10", 18);
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));

  const [, , recipient] = await ethers.getSigners();
  const ptk = await ethers.getContractAt("MockERC20", state.ptk);
  const escrow = await ethers.getContractAt("GitEscrow", state.gitEscrow);

  const repoId = ethers.keccak256(ethers.toUtf8Bytes(repo));
  // MockERC20.mint is permissionless (test token): fund the recipient
  // for exactly this lock so the script works at any point in a driver.
  const mintTx = await ptk.mint(recipient.address, amount);
  await mintTx.wait();
  const approveTx = await ptk.connect(recipient).approve(state.gitEscrow, amount);
  await approveTx.wait();
  const lockTx = await escrow.connect(recipient).lock(repoId, state.ptk, amount, 2, 1);
  const receipt = await lockTx.wait();
  const block = await ethers.provider.getBlock(receipt!.blockNumber);
  console.log("repo:", repo, "repoId:", repoId, "blockTimestamp:", block?.timestamp);
  console.log(`LOCK_TX=${lockTx.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
