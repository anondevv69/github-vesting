import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const oracleAddress = process.env.ORACLE_ADDRESS ?? deployer.address;
  console.log("Oracle address:", oracleAddress);

  const GitEscrow = await ethers.getContractFactory("GitEscrow");
  const escrow = await GitEscrow.deploy(oracleAddress);
  await escrow.waitForDeployment();

  const address = await escrow.getAddress();
  const network = await ethers.provider.getNetwork();
  console.log("GitEscrow deployed to:", address);
  console.log("Network chainId:", network.chainId.toString());
  if (network.chainId === 4663n) {
    console.log("Set GIT_ESCROW_ROBINHOOD_ADDRESS=" + address + " in your .env");
  } else {
    console.log("Set GIT_ESCROW_ADDRESS=" + address + " in your .env");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
