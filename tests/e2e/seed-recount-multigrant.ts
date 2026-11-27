/**
 * TEST-ONLY seed for recount Stage 16: V3 grant records for grants
 * C (baseline 0) and D (baseline 2) on testowner/testrepo, matching
 * deploy-v3-recount.ts.
 */
import * as fs from "fs";
import * as path from "path";
import { saveGrantById, type GrantRecord } from "../../src/lib/redis";
import { repoIdFromFullName } from "../../src/lib/repoId";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
  const v3State = JSON.parse(fs.readFileSync(path.join(__dirname, "state-recount-v3.json"), "utf8"));
  const repoId = repoIdFromFullName(state.repoFullName);
  const now = new Date().toISOString();
  const baseRec = {
    repoId,
    repoFullName: state.repoFullName,
    platform: "github" as const,
    recipient: state.recipient,
    token: state.ptk,
    chain: "base" as const,
    totalLocked: (300n * 10n ** 18n).toString(),
    totalPushesRequired: 3,
    pushesPerMilestone: 1,
    tokensPerMilestone: (100n * 10n ** 18n).toString(),
    verifiedPushCount: 0,
    lastPaidMilestone: 0,
    installationId: 0,
    status: "active" as const,
    streaming: false,
    escrowAddress: v3State.v3,
    escrowVersion: 3 as const,
    createdAt: now,
    updatedAt: now,
  };
  const grantC: GrantRecord = {
    ...baseRec,
    onChainTxHash: v3State.lockTxC,
    grantId: v3State.grantC,
    startPushCount: 0,
  };
  const grantD: GrantRecord = {
    ...baseRec,
    onChainTxHash: v3State.lockTxD,
    grantId: v3State.grantD,
    startPushCount: 2,
    createdAt: new Date(Date.now() + 10).toISOString(),
  };
  await saveGrantById(grantC);
  await saveGrantById(grantD);
  console.log("recount multigrant records saved:", v3State.grantC, v3State.grantD);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
