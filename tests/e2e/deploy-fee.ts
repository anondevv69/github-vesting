/**
 * TEST-ONLY deploy for the FEE-LOCK suite (local Hardhat node only).
 *
 * Deploys: MockERC20 PTK (project token), MockERC20 RWD (reward token),
 * MockERC20 WETH (fee asset), GitEscrowV2 (oracle = acct #1),
 * ShipRewards (oracle = #1, RWD), FeeStreamEscrow (oracle = #1),
 * FeeLockVault (escrow = FeeStreamEscrow, token = WETH, repoId,
 * launcher = recipient), MockFeeClaimSource (WETH).
 * Then:
 *   - recipient (acct #2) locks 1,000 PTK into GitEscrowV2 for
 *     testowner/testrepo (totalPushes=4, pushesPerMilestone=2 →
 *     500 PTK per supply milestone);
 *   - the deployer (FeeStreamEscrow owner = registrar, round-3)
 *     registers the fee grant on FeeStreamEscrow
 *     (pushesPerTranche=2) naming the recipient + the vault — the
 *     contract validates the vault's bindings on-chain;
 *   - deployer funds ShipRewards with 10,000 RWD;
 *   - claim source holds 1,000 WETH with 40 WETH claimable by the vault
 *     (models trading fees accrued to the vault as fee recipient).
 * Writes tests/e2e/state-fee.json.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer, oracle, recipient, author] = await ethers.getSigners();
  const repoFullName = "testowner/testrepo";
  const repoId = ethers.keccak256(ethers.toUtf8Bytes(repoFullName));

  const Mock = await ethers.getContractFactory("MockERC20");
  const ptk = await Mock.deploy("Project Token", "PTK", 18);
  const rwd = await Mock.deploy("Ship Reward", "RWD", 18);
  const weth = await Mock.deploy("Wrapped Ether", "WETH", 18);

  const EscrowV2 = await ethers.getContractFactory("GitEscrowV2");
  const escrow = await EscrowV2.deploy(oracle.address);

  const Rewards = await ethers.getContractFactory("ShipRewards");
  const rewards = await Rewards.deploy(oracle.address, await rwd.getAddress());

  const FeeEscrow = await ethers.getContractFactory("FeeStreamEscrow");
  const feeEscrow = await FeeEscrow.deploy(oracle.address);
  const feeEscrowAddr = await feeEscrow.getAddress();

  // The claim source deploys BEFORE the vault: the vault's
  // constructor takes the claim ledger and restricts its own claim
  // policy on it (Bankr's contract-recipient rule, round-2).
  const Source = await ethers.getContractFactory("MockFeeClaimSource");
  const source = await Source.deploy(await weth.getAddress());
  const sourceAddr = await source.getAddress();

  const Vault = await ethers.getContractFactory("FeeLockVault");
  const vault = await Vault.deploy(feeEscrowAddr, await weth.getAddress(), repoId, recipient.address, sourceAddr);
  const vaultAddr = await vault.getAddress();

  // Balances.
  await (await ptk.mint(recipient.address, ethers.parseUnits("1000", 18))).wait();
  await (await rwd.mint(deployer.address, ethers.parseUnits("10000", 18))).wait();
  await (await weth.mint(deployer.address, ethers.parseUnits("1000", 18))).wait();
  await (await weth.transfer(sourceAddr, ethers.parseUnits("1000", 18))).wait();
  await (await source.accrue(vaultAddr, ethers.parseUnits("40", 18))).wait();

  // Supply lock into V2: 1,000 PTK, 4 pushes total, milestone every 2.
  await (await ptk.connect(recipient).approve(await escrow.getAddress(), ethers.parseUnits("1000", 18))).wait();
  const lockTx = await escrow
    .connect(recipient)
    .lock(repoId, await ptk.getAddress(), ethers.parseUnits("1000", 18), 4, 2);
  await lockTx.wait();

  // Fee grant registration (round-3): the escrow OWNER (registrar)
  // registers recipient + token + vault explicitly; the contract
  // validates the vault's immutable bindings before accepting.
  const regTx = await feeEscrow
    .connect(deployer)
    .registerFeeGrant(repoId, recipient.address, await weth.getAddress(), vaultAddr, 2);
  await regTx.wait();

  // Fund the reward pool.
  await (await rwd.transfer(await rewards.getAddress(), ethers.parseUnits("10000", 18))).wait();

  const state = {
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    oracle: oracle.address,
    recipient: recipient.address,
    author: author.address,
    ptk: await ptk.getAddress(),
    rwd: await rwd.getAddress(),
    weth: await weth.getAddress(),
    gitEscrow: await escrow.getAddress(),
    shipRewards: await rewards.getAddress(),
    feeStreamEscrow: feeEscrowAddr,
    feeLockVault: vaultAddr,
    feeClaimSource: sourceAddr,
    repoId,
    repoFullName,
    lockTx: lockTx.hash,
    deployTxs: { ptk: ptk.deploymentTransaction()?.hash },
  };
  const out = path.join(__dirname, "state-fee.json");
  fs.writeFileSync(out, JSON.stringify(state, null, 2));
  console.log("state-fee written:", JSON.stringify(state, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
