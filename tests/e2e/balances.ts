/**
 * TEST-ONLY balance reader (viem, local RPC). Usage:
 *   tsx tests/e2e/balances.ts <label>
 * Prints PTK/RWD balances for recipient + author, escrow PTK, pool RWD.
 */
import * as fs from "fs";
import * as path from "path";
import { createPublicClient, http, parseAbi, formatUnits, type Address } from "viem";
import { base } from "viem/chains";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const label = process.argv[2] ?? "balances";
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
  const client = createPublicClient({ chain: base, transport: http("http://127.0.0.1:8545") });
  const bal = (token: string, who: string) =>
    client.readContract({ address: token as Address, abi: ERC20, functionName: "balanceOf", args: [who as Address] });

  const [recPtk, escrowPtk, authRwd, poolRwd] = await Promise.all([
    bal(state.ptk, state.recipient),
    bal(state.ptk, state.gitEscrow),
    bal(state.rwd, state.author),
    bal(state.rwd, state.shipRewards),
  ]);
  console.log(
    `[${label}] recipient PTK=${formatUnits(recPtk, 18)} | escrow PTK=${formatUnits(escrowPtk, 18)} | author RWD=${formatUnits(authRwd, 18)} | ShipRewards pool RWD=${formatUnits(poolRwd, 18)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
