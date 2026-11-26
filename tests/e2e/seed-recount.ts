/**
 * TEST-ONLY seed for the recount suite: Redis grant matching
 * deploy-recount.ts (900 PTK, 3 pushes, milestone every 1) + the PR
 * author's linked wallet.
 */
import * as fs from "fs";
import * as path from "path";
import { saveGrant, type GrantRecord } from "../../src/lib/redis";
import { repoIdFromFullName } from "../../src/lib/repoId";
import { addLinkedWallet } from "../../src/lib/devWallets";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
  const repoId = repoIdFromFullName(state.repoFullName);
  const grant: GrantRecord = {
    repoId,
    repoFullName: state.repoFullName,
    platform: "github",
    recipient: state.recipient,
    token: state.ptk,
    chain: "base",
    totalLocked: (900n * 10n ** 18n).toString(),
    totalPushesRequired: 3,
    pushesPerMilestone: 1,
    tokensPerMilestone: (300n * 10n ** 18n).toString(),
    verifiedPushCount: 0,
    lastPaidMilestone: 0,
    onChainTxHash: state.lockTx,
    installationId: 0,
    status: "active",
    streaming: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveGrant(grant);
  console.log("grant saved for", state.repoFullName);
  const wallets = await addLinkedWallet("testauthor", state.author, "signed");
  console.log("linked wallets for @testauthor:", JSON.stringify(wallets));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
