/**
 * TEST-ONLY deploy + lock script for the mandatory-window swarm suite
 * (run-swarm-window.sh). Identical to deploy.ts EXCEPT the escrow
 * lock is 1,000 PTK over totalPushes=10 (pushesPerMilestone=1 → 100
 * PTK per milestone): the window suite counts three pushes on one
 * grant, and a 2-push lock would complete the grant mid-suite and
 * divert later pushes into the grant-less path. Writes the same
 * state.json shape as deploy.ts.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer, oracle, recipient, author] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log("chainId:", network.chainId.toString());
  console.log("deployer:", deployer.address);
  console.log("oracle:", oracle.address);
  console.log("recipient:", recipient.address);
  console.log("author:", author.address);

  const Mock = await ethers.getContractFactory("MockERC20");
  const ptk = await Mock.deploy("Project Token", "PTK", 18);
  await ptk.waitForDeployment();
  const ptkAddr = await ptk.getAddress();
  console.log("PTK:", ptkAddr, "deployTx:", ptk.deploymentTransaction()?.hash);

  const rwd = await Mock.deploy("Ship Reward", "RWD", 18);
  await rwd.waitForDeployment();
  const rwdAddr = await rwd.getAddress();
  console.log("RWD:", rwdAddr, "deployTx:", rwd.deploymentTransaction()?.hash);

  const Escrow = await ethers.getContractFactory("GitEscrow");
  const escrow = await Escrow.deploy(oracle.address);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log("GitEscrow:", escrowAddr, "deployTx:", escrow.deploymentTransaction()?.hash);

  const Rewards = await ethers.getContractFactory("ShipRewards");
  const rewards = await Rewards.deploy(oracle.address, rwdAddr);
  await rewards.waitForDeployment();
  const rewardsAddr = await rewards.getAddress();
  console.log("ShipRewards:", rewardsAddr, "deployTx:", rewards.deploymentTransaction()?.hash);

  const mintPtkTx = await ptk.mint(recipient.address, ethers.parseUnits("1000", 18));
  await mintPtkTx.wait();
  console.log("mint PTK→recipient tx:", mintPtkTx.hash);
  const mintRwdTx = await rwd.mint(deployer.address, ethers.parseUnits("10000", 18));
  await mintRwdTx.wait();
  console.log("mint RWD→deployer tx:", mintRwdTx.hash);

  // Recipient locks 1,000 PTK: totalPushes=10, pushesPerMilestone=1
  // → 100 PTK per milestone, grant stays active across the suite.
  const repoId = ethers.keccak256(ethers.toUtf8Bytes("testowner/testrepo"));
  console.log("repoId:", repoId);
  const approveTx = await ptk.connect(recipient).approve(escrowAddr, ethers.parseUnits("1000", 18));
  await approveTx.wait();
  console.log("approve tx:", approveTx.hash);
  const lockTx = await escrow
    .connect(recipient)
    .lock(repoId, ptkAddr, ethers.parseUnits("1000", 18), 10, 1);
  await lockTx.wait();
  console.log("lock tx:", lockTx.hash);

  const grant = await escrow.grants(repoId);
  console.log(
    "on-chain grant: recipient=%s totalLocked=%s tokensPerMilestone=%s active=%s",
    grant.recipient, grant.totalLocked.toString(), grant.tokensPerMilestone.toString(), grant.active,
  );

  const fundTx = await rwd.transfer(rewardsAddr, ethers.parseUnits("10000", 18));
  await fundTx.wait();
  console.log("fund ShipRewards tx:", fundTx.hash);
  console.log("ShipRewards RWD balance:", (await rwd.balanceOf(rewardsAddr)).toString());

  const state = {
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    oracle: oracle.address,
    recipient: recipient.address,
    author: author.address,
    ptk: ptkAddr,
    rwd: rwdAddr,
    gitEscrow: escrowAddr,
    shipRewards: rewardsAddr,
    repoId,
    repoFullName: "testowner/testrepo",
    lockTx: lockTx.hash,
    deployTxs: {
      ptk: ptk.deploymentTransaction()?.hash,
      rwd: rwd.deploymentTransaction()?.hash,
      gitEscrow: escrow.deploymentTransaction()?.hash,
      shipRewards: rewards.deploymentTransaction()?.hash,
      fundRewards: fundTx.hash,
    },
  };
  const out = path.join(__dirname, "state.json");
  fs.writeFileSync(out, JSON.stringify(state, null, 2));
  console.log("state written to", out);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
