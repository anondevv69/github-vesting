/**
 * TEST-ONLY deploy for the round-4 fee-release CAP test (local
 * Hardhat node only; driven from run-fee-lock.sh step 37).
 *
 * Builds a fee grant for testowner/caprepo whose vault locks FORTY
 * 1-WETH tranches, all at baseline 0 with pushesPerTranche=1 — so a
 * single counted push vests all 40 at once, far beyond the
 * contract's MAX_TRANCHES_PER_RELEASE (16). Every lock goes through
 * an oracle-signed CountAttestation (round-4 path). The backend
 * half (fee-cap.ts) then proves the release stays queued until the
 * sweep drains it to zero — with no new pushes.
 * Writes tests/e2e/state-cap.json.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const ATTESTATION_TYPES = {
  CountAttestation: [
    { name: "escrow", type: "address" },
    { name: "repoId", type: "bytes32" },
    { name: "vault", type: "address" },
    { name: "countedTotal", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

async function main() {
  const [deployer, oracle, recipient] = await ethers.getSigners();
  const repoFullName = "testowner/caprepo";
  const repoId = ethers.keccak256(ethers.toUtf8Bytes(repoFullName));

  const Mock = await ethers.getContractFactory("MockERC20");
  const weth = await Mock.deploy("Wrapped Ether", "WETH", 18);
  const wethAddr = await weth.getAddress();

  const Source = await ethers.getContractFactory("MockFeeClaimSource");
  const source = await Source.deploy(wethAddr);
  const sourceAddr = await source.getAddress();

  const FeeEscrow = await ethers.getContractFactory("FeeStreamEscrow");
  const feeEscrow = await FeeEscrow.deploy(oracle.address);
  const feeEscrowAddr = await feeEscrow.getAddress();

  const Vault = await ethers.getContractFactory("FeeLockVault");
  const vault = await Vault.deploy(feeEscrowAddr, wethAddr, repoId, recipient.address, sourceAddr);
  const vaultAddr = await vault.getAddress();

  await (
    await feeEscrow
      .connect(deployer)
      .registerFeeGrant(repoId, recipient.address, wethAddr, vaultAddr, 1)
  ).wait();

  await (await weth.mint(deployer.address, ethers.parseUnits("100", 18))).wait();
  await (await weth.transfer(sourceAddr, ethers.parseUnits("100", 18))).wait();

  const claimData = source.interface.encodeFunctionData("collectFees", [ethers.ZeroHash]);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  for (let i = 0; i < 40; i++) {
    await (await source.accrue(vaultAddr, ethers.parseUnits("1", 18))).wait();
    await (await vault.connect(deployer).claimFees(claimData)).wait();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const att = {
      escrow: feeEscrowAddr,
      repoId,
      vault: vaultAddr,
      countedTotal: 0n,
      issuedAt: BigInt(now),
      expiry: BigInt(now + 300),
      nonce: BigInt(i + 1),
    };
    const sig = await oracle.signTypedData(
      { name: "ProofOfDev FeeStreamEscrow", version: "1", chainId, verifyingContract: feeEscrowAddr },
      ATTESTATION_TYPES,
      att,
    );
    await (await vault.connect(deployer).lockAccrued(0n, att, sig)).wait();
  }

  const state = {
    repoFullName,
    repoId,
    feeStreamEscrow: feeEscrowAddr,
    feeLockVault: vaultAddr,
    weth: wethAddr,
    recipient: recipient.address,
    deployer: deployer.address,
    oracle: oracle.address,
  };
  fs.writeFileSync(path.join(__dirname, "state-cap.json"), JSON.stringify(state, null, 2));
  console.log("CAP_STATE " + JSON.stringify(state));
  console.log(`CAP_DEPLOY tranches=${await feeEscrow.trancheCount(repoId)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
