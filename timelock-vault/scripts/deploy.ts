import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Deploying TimeLockVault with:", deployer.address);
  console.log("Chain ID:", network.chainId.toString());

  const Vault = await ethers.getContractFactory("TimeLockVault");
  const vault = await Vault.deploy();
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  console.log("TimeLockVault deployed to:", address);
  console.log("Explorer: https://robinhoodchain.blockscout.com/address/" + address);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
