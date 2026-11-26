/**
 * TEST-ONLY deploy for the STITCHED E2E suite (run-stitched-e2e.sh).
 * Local Hardhat node only; no supply lock and no fee-grant
 * registration here — those happen in the driver AFTER GitHub
 * verification + prepare-launch, in production order.
 *
 * Deploys: MockERC20 PTK (the launched token), MockERC20 RWD (reward
 * token), MockERC20 WETH (fee asset), GitEscrowV2 (oracle = acct #1),
 * ShipRewards (oracle = #1, RWD), FeeStreamEscrow (oracle = #1),
 * MockFeeClaimSource (WETH), ONE FeeLockVault from the approved
 * implementation bound to testowner/testrepo + the recipient, and a
 * MockBankrLaunchRecord carrying PTK's launch fee configuration —
 * the LOCAL STAND-IN for the stage-4 SDK launch leg (proven on
 * mainnet in round 2): exactly the prepared production split,
 * 2500 bps to the treasury stand-in (deployer) + 7500 bps to the
 * vault, set with the same pool/bucket derivation as
 * deploy-gate-recognition.ts.
 *
 * Also: 40 WETH claimable by the vault on the claim source (models
 * trading fees accrued to the vault as fee recipient), ShipRewards
 * funded with 10,000 RWD.
 *
 * Writes state-stitched.json, plus state.json / state-fee.json in
 * the established shapes so balances.ts, balances-fee.ts,
 * fee-state.ts, fee-retry.ts, fee-topup.ts and lock-for-repo-fee.ts
 * work unchanged against this deployment.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer, oracle, recipient, author] = await ethers.getSigners();
  const repoFullName = "testowner/testrepo";
  const repoId = ethers.keccak256(ethers.toUtf8Bytes(repoFullName));
  // The deployer stands in as the designated reward treasury (the
  // driver's PLATFORM_REWARD_TREASURY_WALLET) — plumbing proof only.
  const treasury = deployer;

  const Mock = await ethers.getContractFactory("MockERC20");
  const ptk = await Mock.deploy("Project Token", "PTK", 18);
  const rwd = await Mock.deploy("Ship Reward", "RWD", 18);
  const weth = await Mock.deploy("Wrapped Ether", "WETH", 18);
  const ptkAddr = await ptk.getAddress();
  const wethAddr = await weth.getAddress();

  const EscrowV2 = await ethers.getContractFactory("GitEscrowV2");
  const escrow = await EscrowV2.deploy(oracle.address);
  const escrowAddr = await escrow.getAddress();

  const Rewards = await ethers.getContractFactory("ShipRewards");
  const rewards = await Rewards.deploy(oracle.address, await rwd.getAddress());
  const rewardsAddr = await rewards.getAddress();

  const FeeEscrow = await ethers.getContractFactory("FeeStreamEscrow");
  const feeEscrow = await FeeEscrow.deploy(oracle.address);
  const feeEscrowAddr = await feeEscrow.getAddress();

  const Source = await ethers.getContractFactory("MockFeeClaimSource");
  const source = await Source.deploy(wethAddr);
  const sourceAddr = await source.getAddress();

  const Vault = await ethers.getContractFactory("FeeLockVault");
  const vault = await Vault.deploy(feeEscrowAddr, wethAddr, repoId, recipient.address, sourceAddr);
  const vaultAddr = await vault.getAddress();

  // Stage-4 LOCAL STAND-IN: the token's launch record, exactly the
  // prepared production split (treasury 2500 / vault 7500).
  const Record = await ethers.getContractFactory("MockBankrLaunchRecord");
  const record = await Record.deploy();
  const recordAddr = await record.getAddress();
  const poolId = ethers.keccak256(ethers.toUtf8Bytes(`mock-pool:${ptkAddr.toLowerCase()}`));
  const bucketId = ethers.solidityPackedKeccak256(["bytes32", "string"], [poolId, "creator"]);
  await (
    await record.setLaunch(
      ptkAddr,
      poolId,
      bucketId,
      [treasury.address, vaultAddr],
      [2500n * 10n ** 14n, 7500n * 10n ** 14n],
    )
  ).wait();
  console.log(`RECORD_SET token=${ptkAddr} recipients=[["${treasury.address}",2500],["${vaultAddr}",7500]]`);

  // Balances.
  await (await ptk.mint(recipient.address, ethers.parseUnits("1000", 18))).wait();
  await (await rwd.mint(deployer.address, ethers.parseUnits("10000", 18))).wait();
  await (await weth.mint(deployer.address, ethers.parseUnits("1000", 18))).wait();
  await (await weth.transfer(sourceAddr, ethers.parseUnits("1000", 18))).wait();
  await (await source.accrue(vaultAddr, ethers.parseUnits("40", 18))).wait();

  // Fund the reward pool.
  await (await rwd.transfer(rewardsAddr, ethers.parseUnits("10000", 18))).wait();

  const base = {
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    oracle: oracle.address,
    recipient: recipient.address,
    author: author.address,
    ptk: ptkAddr,
    rwd: await rwd.getAddress(),
    weth: wethAddr,
    gitEscrow: escrowAddr,
    shipRewards: rewardsAddr,
    feeStreamEscrow: feeEscrowAddr,
    feeLockVault: vaultAddr,
    feeClaimSource: sourceAddr,
    bankrRecord: recordAddr,
    repoId,
    repoFullName,
    lockTx: "",
    deployTxs: { ptk: ptk.deploymentTransaction()?.hash },
  };
  fs.writeFileSync(path.join(__dirname, "state-stitched.json"), JSON.stringify(base, null, 2));
  fs.writeFileSync(path.join(__dirname, "state.json"), JSON.stringify(base, null, 2));
  fs.writeFileSync(path.join(__dirname, "state-fee.json"), JSON.stringify(base, null, 2));
  console.log("state-stitched written:", JSON.stringify(base, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
