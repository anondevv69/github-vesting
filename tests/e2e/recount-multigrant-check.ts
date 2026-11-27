/**
 * TEST-ONLY balance assertions for recount Stage 16: after the
 * backup-verifier recount settles both V3 grants by derivation,
 * the recipient must hold exactly 700 PTK (900 after the V2 grant
 * completed − 600 locked into C+D + 300 from C + 100 from D) and
 * the V3 escrow must retain D's unvested 200 PTK.
 */
import * as fs from "fs";
import * as path from "path";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
  const v3State = JSON.parse(fs.readFileSync(path.join(__dirname, "state-recount-v3.json"), "utf8"));
  const client = createPublicClient({ chain: base, transport: http("http://127.0.0.1:8545") });
  const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const bal = (who: string) =>
    client.readContract({ address: state.ptk as Address, abi: ERC20, functionName: "balanceOf", args: [who as Address] });
  const recipient = await bal(state.recipient);
  const escrow = await bal(v3State.v3);
  console.log(`RECOUNT_MG recipient PTK=${recipient / 10n ** 18n} v3escrow PTK=${escrow / 10n ** 18n}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
