/**
 * TEST-ONLY deploy for the LAUNCH-GATE suite's round-3 recognition
 * steps (local Hardhat node only).
 *
 * Round 3 made a prepared-launch record REQUIRED for the
 * launchVerified stamp, so the gate suite's stamped happy path
 * (step 18) now goes through prepare-launch like production. This
 * fixture deploys everything that flow needs on the "base" chain
 * config (the suite points the chain's Bankr factory/ledger and
 * FeeStreamEscrow config at these mocks via env):
 *   - GitEscrowV2 (the configured escrow the step-18 lock goes into)
 *   - FeeStreamEscrow + MockFeeClaimSource
 *   - FeeLockVaults bound to the suite's repos (launchrepo,
 *     chainrepo, stalerepo), launcher = recipient (Hardhat #2) —
 *     genuine instances of the approved implementation, so the
 *     canonical-implementation check passes
 *   - MockBankrLaunchRecord with the step-18 token's fee
 *     configuration set to the production split: 2500 bps to the
 *     treasury stand-in (the deployer, the driver's
 *     PLATFORM_REWARD_TREASURY_WALLET) + 7500 bps to the launchrepo
 *     vault; per-repo tokens (CTK/STK) for the chaining steps carry
 *     the same split to their repos' vaults
 * Writes tests/e2e/state-gate.json.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer, oracle, recipient] = await ethers.getSigners();
  // The driver's PLATFORM_REWARD_TREASURY_WALLET is the deployer —
  // the prepared split's treasury position must match it exactly.
  const treasury = deployer;

  const Mock = await ethers.getContractFactory("MockERC20");
  // The step-18 token is deploy.ts's PTK (state.json) — the mock
  // record must carry THAT token's fee configuration.
  const baseState = JSON.parse(
    fs.readFileSync(path.join(__dirname, "state.json"), "utf8"),
  ) as { ptk: string };
  const ptkAddr = baseState.ptk;
  const weth = await Mock.deploy("Wrapped Ether", "WETH", 18);
  const wethAddr = await weth.getAddress();

  const EscrowV2 = await ethers.getContractFactory("GitEscrowV2");
  const escrow = await EscrowV2.deploy(oracle.address);
  const escrowAddr = await escrow.getAddress();

  const FeeEscrow = await ethers.getContractFactory("FeeStreamEscrow");
  const feeEscrow = await FeeEscrow.deploy(oracle.address);
  const feeEscrowAddr = await feeEscrow.getAddress();

  const Source = await ethers.getContractFactory("MockFeeClaimSource");
  const source = await Source.deploy(wethAddr);
  const sourceAddr = await source.getAddress();

  const Record = await ethers.getContractFactory("MockBankrLaunchRecord");
  const record = await Record.deploy();
  const recordAddr = await record.getAddress();

  const Vault = await ethers.getContractFactory("FeeLockVault");
  const deployVault = async (repoFullName: string) => {
    const repoId = ethers.keccak256(ethers.toUtf8Bytes(repoFullName));
    const v = await Vault.deploy(feeEscrowAddr, wethAddr, repoId, recipient.address, sourceAddr);
    return v.getAddress();
  };
  const vaultLaunch = await deployVault("testauthor/launchrepo");
  const vaultChain = await deployVault("testauthor/chainrepo");
  const vaultStale = await deployVault("testauthor/stalerepo");
  const vaultOrder = await deployVault("testauthor/orderrepo");
  const vaultNolock = await deployVault("testauthor/nolockrepo");

  // Round-4 (blocker 3): prepare-launch now requires the matching
  // fee grant to be REGISTERED before it returns an input, so the
  // registrar registers each suite repo's grant here (ppt=2).
  const registerGrant = async (repoFullName: string, vaultAddr: string, ppt = 2) => {
    const repoId = ethers.keccak256(ethers.toUtf8Bytes(repoFullName));
    await (
      await feeEscrow
        .connect(deployer)
        .registerFeeGrant(repoId, recipient.address, wethAddr, vaultAddr, ppt)
    ).wait();
  };
  await registerGrant("testauthor/launchrepo", vaultLaunch);
  await registerGrant("testauthor/chainrepo", vaultChain);
  await registerGrant("testauthor/stalerepo", vaultStale);
  await registerGrant("testauthor/orderrepo", vaultOrder);
  await registerGrant("testauthor/nolockrepo", vaultNolock);

  // Round-4 wrong-binding vaults for the prepare-launch refusal
  // steps: each is a GENUINE instance of the approved implementation
  // with exactly ONE binding wrong (the codehash check passes; the
  // binding check must refuse with the field's code).
  const bindRepoId = ethers.keccak256(ethers.toUtf8Bytes("testauthor/bindingsrepo"));
  // repo: bound to a different repo's id
  const vaultBindRepo = await (
    await Vault.deploy(
      feeEscrowAddr,
      wethAddr,
      ethers.keccak256(ethers.toUtf8Bytes("testauthor/notbindingsrepo")),
      recipient.address,
      sourceAddr,
    )
  ).getAddress();
  // launcher: bound to the deployer, not the verified wallet
  const vaultBindLauncher = await (
    await Vault.deploy(feeEscrowAddr, wethAddr, bindRepoId, deployer.address, sourceAddr)
  ).getAddress();
  // escrow: bound to a second FeeStreamEscrow instance
  const feeEscrowWrong = await FeeEscrow.deploy(oracle.address);
  const vaultBindEscrow = await (
    await Vault.deploy(await feeEscrowWrong.getAddress(), wethAddr, bindRepoId, recipient.address, sourceAddr)
  ).getAddress();
  // token: bound to a non-WETH fee token
  const notWeth = await Mock.deploy("Not WETH", "NWETH", 18);
  const vaultBindToken = await (
    await Vault.deploy(feeEscrowAddr, await notWeth.getAddress(), bindRepoId, recipient.address, sourceAddr)
  ).getAddress();
  // ledger: bound to a second claim-source instance, not the
  // configured Bankr claim ledger
  const source2 = await Source.deploy(wethAddr);
  const vaultBindLedger = await (
    await Vault.deploy(feeEscrowAddr, wethAddr, bindRepoId, recipient.address, await source2.getAddress())
  ).getAddress();
  // grantless: bindings fully correct for its repo, but NO fee
  // grant is ever registered for it
  const vaultNogrant = await deployVault("testauthor/nograntrepo");
  // grant-mismatch: bindings correct; its grant IS registered but
  // with pushesPerTranche=3, so a prepare expecting 2 must refuse
  const vaultGrantmis = await deployVault("testauthor/grantmisrepo");
  await registerGrant("testauthor/grantmisrepo", vaultGrantmis, 3);

  // Per-repo tokens for the round-3 chaining steps (29/30): each
  // repo's registration must present the token its lock actually
  // locked, and the mock record carries that token's fee config.
  const ctk = await Mock.deploy("Chain Token", "CTK", 18);
  const ctkAddr = await ctk.getAddress();
  const stk = await Mock.deploy("Stale Token", "STK", 18);
  const stkAddr = await stk.getAddress();
  await (await ctk.mint(recipient.address, ethers.parseUnits("1000", 18))).wait();
  await (await stk.mint(recipient.address, ethers.parseUnits("1000", 18))).wait();

  // The tokens' actual fee configurations on the mock record:
  // exactly the prepared production split for each repo. The mock
  // takes the real Bankr shapes (poolId + derived creator bucket +
  // shares as wad) — same derivation as deploy-recognition.ts.
  const setRecord = async (tokenAddr: string, vaultAddr: string) => {
    const poolId = ethers.keccak256(ethers.toUtf8Bytes(`mock-pool:${tokenAddr.toLowerCase()}`));
    const bucketId = ethers.solidityPackedKeccak256(["bytes32", "string"], [poolId, "creator"]);
    await (
      await record.setLaunch(
        tokenAddr,
        poolId,
        bucketId,
        [treasury.address, vaultAddr],
        [2500n * 10n ** 14n, 7500n * 10n ** 14n],
      )
    ).wait();
  };
  await setRecord(ptkAddr, vaultLaunch);
  await setRecord(ctkAddr, vaultChain);
  await setRecord(stkAddr, vaultStale);

  const state = {
    escrowV2: escrowAddr,
    feeStreamEscrow: feeEscrowAddr,
    bankrRecord: recordAddr,
    claimSource: sourceAddr,
    vaultLaunch,
    vaultChain,
    vaultStale,
    vaultOrder,
    vaultNolock,
    vaultBindRepo,
    vaultBindLauncher,
    vaultBindEscrow,
    vaultBindToken,
    vaultBindLedger,
    vaultNogrant,
    vaultGrantmis,
    ptk: ptkAddr,
    ctk: ctkAddr,
    stk: stkAddr,
    weth: wethAddr,
    recipient: recipient.address,
    deployer: deployer.address,
    oracle: oracle.address,
  };
  fs.writeFileSync(path.join(__dirname, "state-gate.json"), JSON.stringify(state, null, 2));
  console.log("GATE_RECOGNITION_STATE " + JSON.stringify(state));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
