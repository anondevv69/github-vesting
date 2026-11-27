/**
 * TEST-ONLY (Phase 2, stitched Stage 10): deploy GitEscrowV3 beside
 * the stitched suite's V2 escrow and create the multi-lock fixtures:
 *   - V3 grant A + grant B on testowner/testrepo (10 PTK each, 2/1),
 *     recipient = Hardhat #2 — the repo whose V2 grant completed in
 *     the earlier stages;
 *   - a second V2-escrow lock on testowner/stitched-plain, whose
 *     stage-9a V2 grant is still active — its registration must
 *     still be refused 409 after the repoint.
 * Writes tests/e2e/state-v3-stitched.json.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const stitched = JSON.parse(
    fs.readFileSync(path.join(__dirname, "state-stitched.json"), "utf8"),
  );
  const [, oracle, recipient] = await ethers.getSigners();

  const V3 = await ethers.getContractFactory("GitEscrowV3");
  const v3 = await V3.deploy(oracle.address);
  const v3Addr = await v3.getAddress();

  const ptk = await ethers.getContractAt("MockERC20", stitched.ptk);
  const amount = ethers.parseUnits("10", 18);
  await (await ptk.mint(recipient.address, ethers.parseUnits("100", 18))).wait();

  const repoId = ethers.keccak256(ethers.toUtf8Bytes("testowner/testrepo"));
  const grants: Record<string, string> = {};
  for (const name of ["A", "B"]) {
    await (await ptk.connect(recipient).approve(v3Addr, amount)).wait();
    const tx = await v3.connect(recipient).lock(repoId, stitched.ptk, amount, 2, 1);
    const receipt = await tx.wait();
    const log = receipt!.logs
      .map((l) => { try { return v3.interface.parseLog(l); } catch { return null; } })
      .find((l) => l?.name === "Locked");
    grants[`grant${name}`] = log!.args.grantId as string;
    grants[`lockTx${name}`] = tx.hash;
    console.log(`V3_LOCK_${name} tx=${tx.hash} grantId=${log!.args.grantId}`);
  }

  const state = { v3: v3Addr, ...grants };
  fs.writeFileSync(path.join(__dirname, "state-v3-stitched.json"), JSON.stringify(state, null, 2));
  console.log("V3 STITCHED STATE:", JSON.stringify(state));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
