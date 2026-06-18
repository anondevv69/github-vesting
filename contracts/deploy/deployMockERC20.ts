import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying MockERC20 with:", deployer.address);

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy("Mock Bankr", "mBANKR", 18);
  await token.waitForDeployment();

  const address = await token.getAddress();
  console.log("MockERC20 deployed to:", address);

  // Mint 1,000,000 mBANKR to the deployer for testing
  const amount = ethers.parseUnits("1000000", 18);
  await token.mint(deployer.address, amount);
  console.log("Minted 1,000,000 mBANKR to:", deployer.address);
  console.log("Set VITE_MOCK_TOKEN_ADDRESS=" + address + " in frontend/.env");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
