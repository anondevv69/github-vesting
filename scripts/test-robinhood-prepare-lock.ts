/**
 * Smoke test: prepare-lock calldata for Robinhood Chain mainnet.
 * Usage: GIT_ESCROW_ROBINHOOD_ADDRESS=0x… npx tsx scripts/test-robinhood-prepare-lock.ts [wallet] [token]
 */

import { prepareLockTransactions } from "../src/lib/lockBuilder";
import { env } from "../src/lib/env";
import type { Address } from "viem";

async function main() {
  const wallet = (process.argv[2] ?? "0x374d91a5674fa7cf86e725093b5848b97e1e13b4") as Address;
  let token = process.argv[3] as Address | undefined;

  if (!env.GIT_ESCROW_ROBINHOOD_ADDRESS) {
    console.error("GIT_ESCROW_ROBINHOOD_ADDRESS not set");
    process.exit(1);
  }

  if (!token) {
    const res = await fetch(
      `https://robinhoodchain.blockscout.com/api/v2/addresses/${wallet}/token-balances`,
    );
    const rows = (await res.json()) as Array<{
      token?: { address_hash?: string; symbol?: string };
      value?: string;
    }>;
    const row = rows.find((r) => r.token?.address_hash && r.value && r.value !== "0");
    if (!row?.token?.address_hash) {
      console.error("No ERC-20 balance found for wallet on Robinhood Chain:", wallet);
      process.exit(1);
    }
    token = row.token.address_hash as Address;
    console.log("Auto-selected token:", row.token.symbol, token);
  }

  const prep = await prepareLockTransactions({
    wallet,
    repoFullName: "anondevv69/github-vesting",
    token,
    amount: "1",
    chain: "robinhood",
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        chain: prep.chain,
        escrow: prep.transactions.at(-1)?.to,
        chainId: prep.transactions[0]?.chainId,
        tokenSymbol: prep.tokenSymbol,
        txCount: prep.transactions.length,
        steps: prep.transactions.map((t) => t.step),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
