/**
 * TEST-ONLY direct ShipRewards contract test (Hardhat, local node):
 * oracle (signer #1) calls pay() once for a fresh merge hash → author
 * balance increases; a second pay() with the SAME hash must revert.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
  const [, oracle, , author] = await ethers.getSigners();

  const rewards = await ethers.getContractAt("ShipRewards", state.shipRewards, oracle);
  const rwd = await ethers.getContractAt("MockERC20", state.rwd);
  const repoId = ethers.keccak256(ethers.toUtf8Bytes(state.repoFullName));
  const mergeKey = ethers.keccak256(ethers.toUtf8Bytes("direct-pay-merge-1"));
  const amount = ethers.parseUnits("5", 18);

  console.log("author RWD before:", ethers.formatUnits(await rwd.balanceOf(author.address), 18));
  const tx = await rewards.pay(repoId, author.address, amount, mergeKey);
  await tx.wait();
  console.log("pay tx:", tx.hash);
  console.log("isPaid:", await rewards.isPaid(mergeKey));
  console.log("author RWD after:", ethers.formatUnits(await rwd.balanceOf(author.address), 18));

  try {
    const tx2 = await rewards.pay(repoId, author.address, amount, mergeKey);
    await tx2.wait();
    console.log("SECOND PAY UNEXPECTEDLY SUCCEEDED — DOUBLE-PAY BUG");
    process.exitCode = 2;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("second pay reverted as expected:", msg.slice(0, 200));
  }
  console.log("author RWD final:", ethers.formatUnits(await rwd.balanceOf(author.address), 18));
  console.log("totalPaid:", ethers.formatUnits(await rewards.totalPaid(), 18));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
