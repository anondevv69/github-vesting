#!/usr/bin/env npx tsx
/**
 * Recover Space/Bankr tokens stuck on the oracle wallet after a legacy release().
 *
 * Usage:
 *   npx tsx scripts/recover-stuck-tokens.ts --recipient 0x... --token 0x...
 *   npx tsx scripts/recover-stuck-tokens.ts --repo-id <repoId hex>
 */

import * as dotenv from "dotenv";
dotenv.config();

import { recoverStuckStreamingTokens } from "../src/oracle/releaseOracle";
import { getGrant } from "../src/lib/redis";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const repoId = getArg("--repo-id");
  const recipient = getArg("--recipient");
  const token = getArg("--token");
  const chain = (getArg("--chain") ?? "base") as "base" | "base-sepolia";

  if (repoId) {
    const grant = await getGrant(repoId);
    if (!grant) throw new Error(`Grant not found: ${repoId}`);
    console.log(`Recovering for ${grant.repoFullName} → ${grant.recipient}`);
    const result = await recoverStuckStreamingTokens(grant);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!recipient || !token) {
    console.error("Provide --repo-id OR both --recipient and --token");
    process.exit(1);
  }

  const result = await recoverStuckStreamingTokens({ recipient, token, chain });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
