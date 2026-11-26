/**
 * Cutover fixture deploy (local Hardhat node, chainId 8453).
 * Deploys MockERC20 + GitEscrow (v1, the "legacy" escrow) +
 * GitEscrowV2 (the "current" escrow), both with oracle = signer #0,
 * then creates one grant in EACH escrow:
 *   - legacy grant: repo cutover/legacy-repo, recipient signer #2,
 *     locked in v1 — the pre-cutover production shape.
 *   - v2 grant: repo cutover/v2-repo, recipient signer #3, locked
 *     in v2 — the post-cutover shape.
 * Writes tests/e2e/state-cutover.json for cutover-release.ts.
 */
import { ethers } from "hardhat";
import { writeFileSync } from "fs";
import { join } from "path";

async function main() {
  const [oracle, , legacyRecipient, v2Recipient] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC20");
  const token = await Mock.deploy("Cutover Test Token", "CTT", 18);
  const tokenAddr = await token.getAddress();

  const V1 = await ethers.getContractFactory("GitEscrow");
  const v1 = await V1.deploy(oracle.address);
  const v1Addr = await v1.getAddress();

  const V2 = await ethers.getContractFactory("GitEscrowV2");
  const v2 = await V2.deploy(oracle.address);
  const v2Addr = await v2.getAddress();

  const amount = ethers.parseEther("1000");
  const legacyRepoId = ethers.keccak256(ethers.toUtf8Bytes("cutover/legacy-repo"));
  const v2RepoId = ethers.keccak256(ethers.toUtf8Bytes("cutover/v2-repo"));

  // Legacy grant: recipient locks 1000 CTT into v1 (2 pushes, 1 per milestone).
  await token.mint(legacyRecipient.address, amount);
  await token.connect(legacyRecipient).approve(v1Addr, amount);
  const lockTxV1 = await v1
    .connect(legacyRecipient)
    .lock(legacyRepoId, tokenAddr, amount, 2, 1);
  await lockTxV1.wait();

  // V2 grant: recipient locks 1000 CTT into v2, same schedule.
  await token.mint(v2Recipient.address, amount);
  await token.connect(v2Recipient).approve(v2Addr, amount);
  const lockTxV2 = await v2.connect(v2Recipient).lock(v2RepoId, tokenAddr, amount, 2, 1);
  await lockTxV2.wait();

  const state = {
    token: tokenAddr,
    v1: v1Addr,
    v2: v2Addr,
    oracle: oracle.address,
    legacyRepoId: legacyRepoId.slice(2),
    v2RepoId: v2RepoId.slice(2),
    legacyRecipient: legacyRecipient.address,
    v2Recipient: v2Recipient.address,
    lockTxV1: lockTxV1.hash,
    lockTxV2: lockTxV2.hash,
  };
  writeFileSync(join(__dirname, "state-cutover.json"), JSON.stringify(state, null, 2));
  console.log("CUTOVER STATE:", JSON.stringify(state));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
