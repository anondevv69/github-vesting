/**
 * Remove a vesting grant from Redis (registry + explore index).
 *
 * Usage:
 *   npx tsx scripts/delete-grant.ts anondevv69/RH-Wallet
 */

import * as dotenv from "dotenv";
dotenv.config();

import { deleteGrantByRepoFullName } from "../src/lib/redis";

async function main(): Promise<void> {
  const repoFullName = process.argv[2]?.trim();
  if (!repoFullName?.includes("/")) {
    console.error("Usage: npx tsx scripts/delete-grant.ts owner/repo");
    process.exit(1);
  }

  const deleted = await deleteGrantByRepoFullName(repoFullName);
  if (!deleted) {
    console.error(`No grant found for ${repoFullName}`);
    process.exit(1);
  }

  console.log(`Deleted grant for ${deleted.repoFullName}`);
  console.log(`  repoId: ${deleted.repoId}`);
  console.log(`  chain: ${deleted.chain}`);
  console.log(`  tx: ${deleted.onChainTxHash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
