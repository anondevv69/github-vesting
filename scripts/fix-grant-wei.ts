#!/usr/bin/env npx tsx
/**
 * Rewrite grant totalLocked / tokensPerMilestone as integer wei strings (fixes scientific notation).
 *
 *   npx tsx scripts/fix-grant-wei.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import { listAllGrants, saveGrant } from "../src/lib/redis";

async function main() {
  const grants = await listAllGrants();
  let fixed = 0;
  for (const grant of grants) {
    const before = JSON.stringify({
      totalLocked: grant.totalLocked,
      tokensPerMilestone: grant.tokensPerMilestone,
    });
    await saveGrant(grant);
    const after = await listAllGrants();
    const updated = after.find((g) => g.repoId === grant.repoId)!;
    const afterStr = JSON.stringify({
      totalLocked: updated.totalLocked,
      tokensPerMilestone: updated.tokensPerMilestone,
    });
    if (before !== afterStr) {
      console.log(`fixed ${grant.repoFullName}:`, before, "→", afterStr);
      fixed++;
    }
  }
  console.log(`Done. ${fixed} grant(s) normalized.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
