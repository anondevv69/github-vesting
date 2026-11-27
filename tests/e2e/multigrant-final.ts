/**
 * TEST-ONLY final assertions for the MULTI-GRANT suite: after the
 * swarm-quorum-counted push (PR #49, driven by run-multigrant.sh
 * through the real webhook + review APIs), BOTH active V3 grants
 * (D and E) must have settled exactly one milestone — a
 * swarm-counted push settles all active grants the same as a
 * fallback-counted one.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra !== undefined ? ` (${String(extra)})` : ""}`);
  if (!cond) failures++;
}

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const state = JSON.parse(readFileSync(join(__dirname, "state-multigrant.json"), "utf8"));
  const E18 = 10n ** 18n;
  const { getGrantById, getRedis, KEYS } = await import("../../src/lib/redis");
  const { repoIdFromFullName } = await import("../../src/lib/repoId");
  const repo1Id = repoIdFromFullName(state.repoFullName);

  const d = await getGrantById(state.grantIdD);
  const e = await getGrantById(state.grantIdE);
  check("grant D settled milestone 1 via the swarm-counted push", d?.lastPaidMilestone === 1 && d?.status === "active", JSON.stringify({ m: d?.lastPaidMilestone, s: d?.status }));
  check("grant E settled milestone 1 via the swarm-counted push", e?.lastPaidMilestone === 1 && e?.status === "active", JSON.stringify({ m: e?.lastPaidMilestone, s: e?.status }));
  check("repo1 counter is 101 after the swarm push", (await getRedis().get(KEYS.pushCount(repo1Id))) === "101");

  const client = createPublicClient({ chain: base, transport: http("http://127.0.0.1:8545") });
  const bal = await client.readContract({
    address: state.ptk as Address, abi: ERC20, functionName: "balanceOf", args: [state.recipient as Address],
  });
  // 100,000 start − repo2 locks (100 V3 + 100 V3 + 100 V2) − D/E locks
  // (400) + D/E milestone payouts (100 + 100) = 99,500.
  check("recipient balance reflects D+E payouts exactly (99,500 PTK)", bal === 99500n * E18, bal.toString());

  console.log(failures === 0 ? "MULTIGRANT FINAL: ALL PASS" : `MULTIGRANT FINAL: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
