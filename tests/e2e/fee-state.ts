/**
 * TEST-ONLY: print the fee grant's on-chain state for the fee-lock
 * driver (round-3 blocker-3 steps): the escrow's knownPushCount
 * (the ON-CHAIN counted total — lags the backend counter while a
 * fee report is pending), the tranche count, and each tranche's
 * baseline / backendCountAtLock / released. Reads state-fee.json.
 *   npx hardhat run … tests/e2e/fee-state.ts
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-fee.json"), "utf8"));
  const escrow = await ethers.getContractAt("FeeStreamEscrow", state.feeStreamEscrow);
  const repoId = state.repoId as string;
  const known = await escrow.knownPushCount(repoId);
  const count = await escrow.trancheCount(repoId);
  console.log(`FEE_STATE knownPushCount=${known} tranches=${count} cursor=${await escrow.settledCursor(repoId)}`);
  for (let i = 0n; i < count; i++) {
    const t = await escrow.getTranche(repoId, i);
    console.log(
      `FEE_STATE tranche${i} amount=${t.amount} baseline=${t.baselinePushCount} backend=${t.backendCountAtLock} released=${t.released}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
