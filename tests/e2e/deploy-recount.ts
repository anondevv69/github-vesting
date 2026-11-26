/**
 * TEST-ONLY deploy for the RECOUNT suite (local Hardhat node only).
 * GitEscrowV2 (oracle = acct #1) + PTK + RWD + ShipRewards, mirroring
 * deploy.ts's state.json shape so balances.ts works unchanged.
 * Supply lock: recipient locks 900 PTK, totalPushes=3,
 * pushesPerMilestone=1 → 300 PTK per milestone.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer, oracle, recipient, author] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC20");
  const ptk = await Mock.deploy("Project Token", "PTK", 18);
  const rwd = await Mock.deploy("Ship Reward", "RWD", 18);

  const Escrow = await ethers.getContractFactory("GitEscrowV2");
  const escrow = await Escrow.deploy(oracle.address);
  const escrowAddr = await escrow.getAddress();

  const Rewards = await ethers.getContractFactory("ShipRewards");
  const rewards = await Rewards.deploy(oracle.address, await rwd.getAddress());
  const rewardsAddr = await rewards.getAddress();

  await (await ptk.mint(recipient.address, ethers.parseUnits("900", 18))).wait();
  await (await rwd.mint(deployer.address, ethers.parseUnits("10000", 18))).wait();

  const repoId = ethers.keccak256(ethers.toUtf8Bytes("testowner/testrepo"));
  await (await ptk.connect(recipient).approve(escrowAddr, ethers.parseUnits("900", 18))).wait();
  const lockTx = await escrow
    .connect(recipient)
    .lock(repoId, await ptk.getAddress(), ethers.parseUnits("900", 18), 3, 1);
  await lockTx.wait();

  await (await rwd.transfer(rewardsAddr, ethers.parseUnits("10000", 18))).wait();

  const state = {
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    oracle: oracle.address,
    recipient: recipient.address,
    author: author.address,
    ptk: await ptk.getAddress(),
    rwd: await rwd.getAddress(),
    gitEscrow: escrowAddr,
    shipRewards: rewardsAddr,
    repoId,
    repoFullName: "testowner/testrepo",
    lockTx: lockTx.hash,
    deployTxs: { ptk: ptk.deploymentTransaction()?.hash },
  };
  fs.writeFileSync(path.join(__dirname, "state.json"), JSON.stringify(state, null, 2));
  console.log("state written (recount deploy):", JSON.stringify(state, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
