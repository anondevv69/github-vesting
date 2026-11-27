/**
 * TEST-ONLY (Phase 2, recount Stage 16): deploy GitEscrowV3 with the
 * BACKUP oracle (Hardhat #4 — the key the recount script signs
 * with) and create two V3 grants on testowner/testrepo, whose
 * certified repo total is 3:
 *   grant C: 300 PTK, 3 pushes / 1 — baseline 0 (fresh V3 escrow)
 *   grant D: 300 PTK, 3 pushes / 1 — baseline 2 (after the backup
 *     oracle reports count 2), so the recount derivation at total 3
 *     owes it exactly one milestone.
 * Writes tests/e2e/state-recount-v3.json.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
  const signers = await ethers.getSigners();
  const recipient = signers[2]!;
  const backup = signers[4]!;

  const V3 = await ethers.getContractFactory("GitEscrowV3");
  const v3 = await V3.deploy(backup.address);
  const v3Addr = await v3.getAddress();

  const ptk = await ethers.getContractAt("MockERC20", state.ptk);
  const repoId = ethers.keccak256(ethers.toUtf8Bytes("testowner/testrepo"));
  const amount = ethers.parseUnits("300", 18);

  await (await ptk.connect(recipient).approve(v3Addr, amount)).wait();
  const txC = await v3.connect(recipient).lock(repoId, state.ptk, amount, 3, 1);
  const receiptC = await txC.wait();
  const logC = receiptC!.logs
    .map((l) => { try { return v3.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "Locked");
  const grantC = logC!.args.grantId as string;
  console.log(`V3_RECOUNT_LOCK_C tx=${txC.hash} grantId=${grantC}`);

  await (await v3.connect(backup).reportCount(repoId, 2)).wait();

  await (await ptk.connect(recipient).approve(v3Addr, amount)).wait();
  const txD = await v3.connect(recipient).lock(repoId, state.ptk, amount, 3, 1);
  const receiptD = await txD.wait();
  const logD = receiptD!.logs
    .map((l) => { try { return v3.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "Locked");
  const grantD = logD!.args.grantId as string;
  const dOnChain = await v3.getGrant(grantD);
  console.log(`V3_RECOUNT_LOCK_D tx=${txD.hash} grantId=${grantD} startPushCount=${dOnChain.startPushCount}`);

  const out = { v3: v3Addr, grantC, grantD, lockTxC: txC.hash, lockTxD: txD.hash };
  fs.writeFileSync(path.join(__dirname, "state-recount-v3.json"), JSON.stringify(out, null, 2));
  console.log("RECOUNT V3 STATE:", JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
