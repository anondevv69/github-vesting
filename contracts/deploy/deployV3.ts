/**
 * Production deploy (multi-lock cutover): GitEscrowV3 on Base mainnet.
 *
 * Deployer = the production oracle wallet (the runbook pattern:
 * deployer = oracle = owner, one wallet). The oracle address is
 * taken from ORACLE_ADDRESS, defaulting to the deployer.
 *
 *   ORACLE_PRIVATE_KEY=<pod oracle key> \
 *   ORACLE_ADDRESS=0x6dfc5fc9fD6E87957AA060c64006cf52b6c034aB \
 *   npx hardhat run contracts/deploy/deployV3.ts --network base
 *
 * Prints the address + deploy tx hash as JSON. V3 is ADDITIVE: V2
 * (0x894e36CbCD183BF5ad79Eba7B988529f0FA769c3) keeps serving its live
 * grants; the backend repoint (GIT_ESCROW_ADDRESS=V3,
 * GIT_ESCROW_V2_ADDRESS=<V2>) makes NEW locks land on V3.
 */
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const oracleAddress = process.env.ORACLE_ADDRESS ?? deployer.address;
  const network = await ethers.provider.getNetwork();
  console.log("Deployer:", deployer.address);
  console.log("Oracle:", oracleAddress);
  console.log("ChainId:", network.chainId.toString());
  if (network.chainId !== 8453n) {
    throw new Error("Refusing: this script is for Base mainnet (8453) only");
  }
  if (oracleAddress.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error("Refusing: production pattern is deployer == oracle (one wallet)");
  }
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance (wei):", bal.toString());
  if (bal === 0n) throw new Error("Refusing: deployer has no ETH for gas");

  const V3 = await ethers.getContractFactory("GitEscrowV3");
  const v3 = await V3.deploy(oracleAddress);
  await v3.waitForDeployment();
  const v3Address = await v3.getAddress();
  const deployTx = v3.deploymentTransaction()?.hash;
  console.log("GitEscrowV3 deployed:", v3Address, "tx:", deployTx);

  // Post-deploy verification reads.
  const v3Oracle = await v3.oracle();
  const v3Owner = await v3.owner();
  const cap = await v3.MAX_GRANTS_PER_REPO();
  console.log(
    "VERIFY:",
    JSON.stringify({
      gitEscrowV3: v3Address,
      v3DeployTx: deployTx,
      v3Oracle,
      v3Owner,
      maxGrantsPerRepo: cap.toString(),
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
