import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Onboarding-suite fixture: the fee-lock stack deployed the way
 * PRODUCTION is deployed — FeeStreamEscrow deployed BY the oracle
 * account, so the escrow's owner (its registrar) and its oracle are
 * the same signer the backend holds as ORACLE_PRIVATE_KEY. (The older
 * gate fixture deploys from account #0 with account #1 as oracle-only;
 * registerFeeGrant is onlyOwner, so that split can never model the
 * onboarding registrar path.)
 *
 * Deliberately deploys NO vault and registers NO grant — onboarding
 * is the system under test.
 */
async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0]!;
  const oracle = signers[1]!; // == backend ORACLE_PRIVATE_KEY in run-onboard.sh
  const recipient = signers[2]!; // deploy.ts's recipient — linked to @testauthor by seed-gate.ts

  const Mock = await ethers.getContractFactory("MockERC20", deployer);
  const weth = await Mock.deploy("Wrapped Ether", "WETH", 18);
  await weth.waitForDeployment();

  const FeeStreamEscrow = await ethers.getContractFactory("FeeStreamEscrow", oracle);
  const escrow = await FeeStreamEscrow.deploy(oracle.address);
  await escrow.waitForDeployment();

  const Source = await ethers.getContractFactory("MockFeeClaimSource", deployer);
  const source = await Source.deploy(await weth.getAddress());
  await source.waitForDeployment();

  const state = {
    escrow: await escrow.getAddress(),
    weth: await weth.getAddress(),
    source: await source.getAddress(),
    oracle: oracle.address,
    recipient: recipient.address,
    chainId: 31337,
  };
  fs.writeFileSync(path.join(__dirname, "state-onboard.json"), JSON.stringify(state, null, 2));
  console.log("onboard fixture state:", state);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
