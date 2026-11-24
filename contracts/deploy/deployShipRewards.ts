import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const oracleAddress = process.env.ORACLE_ADDRESS ?? deployer.address;
  console.log("Oracle address:", oracleAddress);

  // The ERC-20 paid out as the per-merge Ship reward (spec §8B). The pool is
  // funded afterwards by transferring reward tokens to the deployed address.
  const rewardTokenAddress = process.env.SHIP_REWARD_TOKEN_ADDRESS;
  if (!rewardTokenAddress) {
    throw new Error(
      "Set SHIP_REWARD_TOKEN_ADDRESS to the reward token's contract address",
    );
  }
  console.log("Reward token:", rewardTokenAddress);

  const ShipRewards = await ethers.getContractFactory("ShipRewards");
  const rewards = await ShipRewards.deploy(oracleAddress, rewardTokenAddress);
  await rewards.waitForDeployment();

  const address = await rewards.getAddress();
  const network = await ethers.provider.getNetwork();
  console.log("ShipRewards deployed to:", address);
  console.log("Network chainId:", network.chainId.toString());
  console.log("Set SHIP_REWARDS_ADDRESS=" + address + " in your .env");
  console.log(
    "Fund the pool by transferring reward tokens to " + address + ", then set SHIP_REWARD_PER_MERGE (wei per counted merged PR)",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
