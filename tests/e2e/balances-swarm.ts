/**
 * TEST-ONLY swarm balance reader. Usage:
 *   tsx tests/e2e/balances-swarm.ts <label>
 * Prints RWD for author + both reviewers + pool, and PTK for the
 * grant recipient (milestone releases land there).
 */
import * as fs from "fs";
import * as path from "path";
import { createPublicClient, http, parseAbi, formatUnits, type Address } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { REVONE_KEY, REVTWO_KEY } from "./swarm-keys";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const label = process.argv[2] ?? "balances";
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
  const client = createPublicClient({ chain: base, transport: http("http://127.0.0.1:8545") });
  const revone = privateKeyToAccount(REVONE_KEY).address;
  const revtwo = privateKeyToAccount(REVTWO_KEY).address;

  const bal = (token: string, who: string) =>
    client.readContract({
      address: token as Address,
      abi: ERC20,
      functionName: "balanceOf",
      args: [who as Address],
    });

  const [authRwd, rev1Rwd, rev2Rwd, poolRwd, recipPtk] = await Promise.all([
    bal(state.rwd, state.author),
    bal(state.rwd, revone),
    bal(state.rwd, revtwo),
    bal(state.rwd, state.shipRewards),
    bal(state.ptk, state.recipient),
  ]);
  console.log(
    `[${label}] author RWD=${formatUnits(authRwd, 18)} | revone RWD=${formatUnits(rev1Rwd, 18)} | ` +
      `revtwo RWD=${formatUnits(rev2Rwd, 18)} | pool RWD=${formatUnits(poolRwd, 18)} | recipient PTK=${formatUnits(recipPtk, 18)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
