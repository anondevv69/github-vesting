/**
 * Production deploy (2026-11-26 v1→v2 cutover): GitEscrowV2 +
 * FeeStreamEscrow on Base mainnet.
 *
 * Deployer = the production oracle wallet (the runbook pattern:
 * deployer = oracle = owner, one wallet). The oracle address is
 * taken from ORACLE_ADDRESS, defaulting to the deployer.
 *
 *   ORACLE_PRIVATE_KEY=<pod oracle key> \
 *   ORACLE_ADDRESS=0x6dfc5fc9fD6E87957AA060c64006cf52b6c034aB \
 *   npx hardhat run contracts/deploy/deployV2AndFeeEscrow.ts --network base
 *
 * Prints both addresses + deploy tx hashes as JSON. FeeLockVault is
 * NOT deployed here: vaults are per-project, deployed by the
 * platform at launch onboarding (BETA.md step 4) from the canonical
 * implementation whose masked codehash the backend pins.
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

  const V2 = await ethers.getContractFactory("GitEscrowV2");
  const v2 = await V2.deploy(oracleAddress);
  await v2.waitForDeployment();
  const v2Address = await v2.getAddress();
  console.log("GitEscrowV2 deployed:", v2Address, "tx:", v2.deploymentTransaction()?.hash);

  const Fee = await ethers.getContractFactory("FeeStreamEscrow");
  const fee = await Fee.deploy(oracleAddress);
  await fee.waitForDeployment();
  const feeAddress = await fee.getAddress();
  console.log("FeeStreamEscrow deployed:", feeAddress, "tx:", fee.deploymentTransaction()?.hash);

  // Post-deploy verification reads.
  const v2Oracle = await v2.oracle();
  const v2Owner = await v2.owner();
  const feeOracle = await fee.oracle();
  const feeOwner = await fee.owner();
  console.log(
    "VERIFY:",
    JSON.stringify({
      v2: v2Address,
      v2DeployTx: v2.deploymentTransaction()?.hash,
      v2Oracle,
      v2Owner,
      feeStreamEscrow: feeAddress,
      feeDeployTx: fee.deploymentTransaction()?.hash,
      feeOracle,
      feeOwner,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
