/**
 * TEST-ONLY seed for the mandatory-window swarm driver
 * (run-swarm-window.sh): the same grant as seed.ts / seed-swarm.ts
 * but with NO swarm configuration whatsoever — the legacy shape of
 * production grants like anondevv69/pod-live-test, registered before
 * the swarm existed. Under the 2026-11-26 rule the swarm gate must
 * apply to this grant anyway (mandatory, backend policy). Also links
 * wallets for the author + the two reviewer logins (@revone/@revtwo,
 * Hardhat well-known test accounts #5/#6). Run with the same test
 * env as the server.
 */
import * as fs from "fs";
import * as path from "path";
import { privateKeyToAccount } from "viem/accounts";
import { saveGrant, type GrantRecord } from "../../src/lib/redis";
import { repoIdFromFullName } from "../../src/lib/repoId";
import { addLinkedWallet } from "../../src/lib/devWallets";
import { REVONE_KEY, REVTWO_KEY } from "./swarm-keys";

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
    totalLocked: (1000n * 10n ** 18n).toString(),
    totalPushesRequired: 10,
    pushesPerMilestone: 1,
    tokensPerMilestone: (100n * 10n ** 18n).toString(),
    verifiedPushCount: 0,
    lastPaidMilestone: 0,
    onChainTxHash: state.lockTx,
    installationId: 0,
    status: "active",
    streaming: false,
    // Deliberately NO swarmReviewRequired — legacy grant shape.
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveGrant(grant);
  console.log("legacy grant saved for", state.repoFullName, "(no swarm config)");

  const authorWallets = await addLinkedWallet("testauthor", state.author, "signed");
  console.log("linked wallets for @testauthor:", JSON.stringify(authorWallets));

  const revone = privateKeyToAccount(REVONE_KEY).address;
  const revtwo = privateKeyToAccount(REVTWO_KEY).address;
  console.log("revone wallet:", revone);
  console.log("revtwo wallet:", revtwo);
  await addLinkedWallet("revone", revone, "signed");
  await addLinkedWallet("revtwo", revtwo, "signed");
  console.log("linked wallets for @revone/@revtwo saved");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
