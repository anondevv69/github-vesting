/**
 * TEST-ONLY deploy for the MULTI-GRANT suite (Phase 2, design §7).
 * Local Hardhat node only. Deploys PTK + RWD + ShipRewards +
 * GitEscrowV2 (legacy) + GitEscrowV3, then creates the first two
 * grants on testowner/testrepo for the SAME recipient in the SAME
 * token:
 *   - legacy V2 grant: 10,000 PTK, 100 pushes / 1 per milestone
 *   - V3 grant A:      10,000 PTK, 100 pushes / 1 per milestone
 * Grant B (V3, 50/1) is locked later by multigrant-drive.ts, after
 * 10 counted pushes, so its baseline stamps at 10.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Hardhat well-known account #2 (recipient) — public, test-only.
export const RECIPIENT_KEY =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

async function main() {
  const [deployer, oracle, recipient, author] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC20");
  const ptk = await Mock.deploy("Project Token", "PTK", 18);
  const rwd = await Mock.deploy("Ship Reward", "RWD", 18);

  const V2 = await ethers.getContractFactory("GitEscrowV2");
  const v2 = await V2.deploy(oracle.address);
  const v2Addr = await v2.getAddress();

  const V3 = await ethers.getContractFactory("GitEscrowV3");
  const v3 = await V3.deploy(oracle.address);
  const v3Addr = await v3.getAddress();

  const Rewards = await ethers.getContractFactory("ShipRewards");
  const rewards = await Rewards.deploy(oracle.address, await rwd.getAddress());
  const rewardsAddr = await rewards.getAddress();

  await (await ptk.mint(recipient.address, ethers.parseUnits("100000", 18))).wait();
  await (await rwd.mint(deployer.address, ethers.parseUnits("10000", 18))).wait();
  await (await rwd.transfer(rewardsAddr, ethers.parseUnits("10000", 18))).wait();

  const repoId = ethers.keccak256(ethers.toUtf8Bytes("testowner/testrepo"));
  const ptkAddr = await ptk.getAddress();

  // Legacy V2 grant: 10,000 PTK, 100 pushes, 1 per milestone.
  await (await ptk.connect(recipient).approve(v2Addr, ethers.parseUnits("10000", 18))).wait();
  const lockTxV2 = await v2
    .connect(recipient)
    .lock(repoId, ptkAddr, ethers.parseUnits("10000", 18), 100, 1);
  await lockTxV2.wait();

  // V3 grant A: 10,000 PTK, 100 pushes, 1 per milestone (baseline 0).
  await (await ptk.connect(recipient).approve(v3Addr, ethers.parseUnits("10000", 18))).wait();
  const lockTxV3A = await v3
    .connect(recipient)
    .lock(repoId, ptkAddr, ethers.parseUnits("10000", 18), 100, 1);
  const receiptA = await lockTxV3A.wait();
  const lockedA = receiptA!.logs
    .map((l) => { try { return v3.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "Locked");
  const grantIdA = lockedA!.args.grantId as string;

  const state = {
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    oracle: oracle.address,
    recipient: recipient.address,
    recipientKey: RECIPIENT_KEY,
    author: author.address,
    ptk: ptkAddr,
    rwd: await rwd.getAddress(),
    v2: v2Addr,
    v3: v3Addr,
    shipRewards: rewardsAddr,
    repoId,
    repoFullName: "testowner/testrepo",
    lockTxV2: lockTxV2.hash,
    lockTxV3A: lockTxV3A.hash,
    grantIdA,
  };
  fs.writeFileSync(path.join(__dirname, "state-multigrant.json"), JSON.stringify(state, null, 2));
  console.log("state written (multigrant deploy):", JSON.stringify(state, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
