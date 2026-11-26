/**
 * TEST-ONLY seed for the fee-lock suite: registers the Redis grant
 * matching deploy-fee.ts's on-chain locks (supply: 1,000 PTK, 4 pushes,
 * milestone every 2; feeLockVault set so counted pushes run the
 * fee-tranche release step) and links the PR author's wallet.
 */
import * as fs from "fs";
import * as path from "path";
import { saveGrant, type GrantRecord } from "../../src/lib/redis";
import { repoIdFromFullName } from "../../src/lib/repoId";
import { addLinkedWallet } from "../../src/lib/devWallets";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-fee.json"), "utf8"));
  const repoId = repoIdFromFullName(state.repoFullName);
  const grant: GrantRecord = {
    repoId,
    repoFullName: state.repoFullName,
    platform: "github",
    recipient: state.recipient,
    token: state.ptk,
    chain: "base",
    totalLocked: (1000n * 10n ** 18n).toString(),
    totalPushesRequired: 4,
    pushesPerMilestone: 2,
    tokensPerMilestone: (500n * 10n ** 18n).toString(),
    verifiedPushCount: 0,
    lastPaidMilestone: 0,
    onChainTxHash: state.lockTx,
    installationId: 0,
    status: "active",
    streaming: false,
    feeLockVault: state.feeLockVault,
    feePushesPerTranche: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveGrant(grant);
  console.log("grant saved for", state.repoFullName, "vault", state.feeLockVault);
  const wallets = await addLinkedWallet("testauthor", state.author, "signed");
  console.log("linked wallets for @testauthor:", JSON.stringify(wallets));
  // For the prepare-launch gate test: the repo owner links the launcher
  // (recipient) wallet, so verify-github can issue a token for it.
  const ownerWallets = await addLinkedWallet("testowner", state.recipient, "signed");
  console.log("linked wallets for @testowner:", JSON.stringify(ownerWallets));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
