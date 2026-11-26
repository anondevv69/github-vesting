/**
 * TEST-ONLY balance reader for the fee-lock suite.
 * Usage: tsx tests/e2e/balances-fee.ts <label>
 * Prints recipient PTK + WETH (fee releases), author RWD (merge
 * reward), vault WETH (accrued, unlocked), fee-escrow WETH (locked).
 */
import * as fs from "fs";
import * as path from "path";
import { createPublicClient, http, parseAbi, formatUnits, type Address } from "viem";
import { base } from "viem/chains";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const label = process.argv[2] ?? "balances";
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-fee.json"), "utf8"));
  const client = createPublicClient({ chain: base, transport: http("http://127.0.0.1:8545") });
  const bal = (token: string, who: string) =>
    client.readContract({ address: token as Address, abi: ERC20, functionName: "balanceOf", args: [who as Address] });

  const [recPtk, recWeth, authRwd, vaultWeth, feeEscrowWeth] = await Promise.all([
    bal(state.ptk, state.recipient),
    bal(state.weth, state.recipient),
    bal(state.rwd, state.author),
    bal(state.weth, state.feeLockVault),
    bal(state.weth, state.feeStreamEscrow),
  ]);
  console.log(
    `[${label}] recipient PTK=${formatUnits(recPtk, 18)} WETH=${formatUnits(recWeth, 18)} | author RWD=${formatUnits(authRwd, 18)} | vault WETH=${formatUnits(vaultWeth, 18)} | feeEscrow WETH=${formatUnits(feeEscrowWeth, 18)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
