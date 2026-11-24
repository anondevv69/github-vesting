/**
 * TEST-ONLY reward balance reader (viem, local RPC). Usage:
 *   tsx tests/e2e/balances-rewards.ts <label> <extraWallet>
 * Prints RWD balances for the seeded PR author, one extra wallet
 * (e.g. the ghost author's freshly linked wallet), and the pool.
 */
import * as fs from "fs";
import * as path from "path";
import { createPublicClient, http, parseAbi, formatUnits, type Address } from "viem";
import { base } from "viem/chains";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const label = process.argv[2] ?? "balances";
  const extra = process.argv[3] ?? "";
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
  const client = createPublicClient({ chain: base, transport: http("http://127.0.0.1:8545") });
  const bal = (who: string) =>
    client.readContract({
      address: state.rwd as Address,
      abi: ERC20,
      functionName: "balanceOf",
      args: [who as Address],
    });

  const [authRwd, poolRwd, extraRwd] = await Promise.all([
    bal(state.author),
    bal(state.shipRewards),
    extra ? bal(extra) : Promise.resolve(0n),
  ]);
  console.log(
    `[${label}] author RWD=${formatUnits(authRwd, 18)} | extra RWD=${formatUnits(extraRwd, 18)} | ShipRewards pool RWD=${formatUnits(poolRwd, 18)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
