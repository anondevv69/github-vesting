/**
 * TEST-ONLY seed: registers the grant in Redis (via the repo's own
 * saveGrant) matching the on-chain lock from deploy.ts, and links the
 * PR author's wallet (via the repo's own addLinkedWallet).
 * Run with the same test env as the server (inline env vars, no .env file).
 */
import * as fs from "fs";
import * as path from "path";
import { saveGrant, type GrantRecord } from "../../src/lib/redis";
import { repoIdFromFullName } from "../../src/lib/repoId";
import { addLinkedWallet } from "../../src/lib/devWallets";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
  const repoId = repoIdFromFullName(state.repoFullName);
  console.log("server-side repoId (no 0x):", repoId);
  console.log("on-chain repoId matches:", "0x" + repoId === state.repoId.toLowerCase());

  const grant: GrantRecord = {
    repoId,
    repoFullName: state.repoFullName,
    platform: "github",
    recipient: state.recipient,
    token: state.ptk,
    chain: "base",
    totalLocked: (1000n * 10n ** 18n).toString(),
    totalPushesRequired: 2,
    pushesPerMilestone: 1,
    tokensPerMilestone: (500n * 10n ** 18n).toString(),
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
