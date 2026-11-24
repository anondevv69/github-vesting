/**
 * TEST-ONLY direct exercise of src/oracle/shipRewards.payRewardForMerge
 * against the local chain, with the author's wallet linked in fake Redis
 * (seeded by seed.ts). Calls it TWICE with the same merge SHA:
 *   1st call → should pay SHIP_REWARD_PER_MERGE to the author.
 *   2nd call → should no-op (contract isPaid guard / pre-check).
 * Run with the same inline test env as the server.
 */
import * as fs from "fs";
import * as path from "path";
import { createPublicClient, http, parseAbi, formatUnits, type Address } from "viem";
import { base } from "viem/chains";
import { payRewardForMerge } from "../../src/oracle/shipRewards";
import { repoIdFromFullName } from "../../src/lib/repoId";
import type { GrantRecord } from "../../src/lib/redis";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const MERGE_SHA = "e2e42abcdef00000000000000000000000000042".padEnd(40, "0").slice(0, 40);

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
  const client = createPublicClient({ chain: base, transport: http("http://127.0.0.1:8545") });
  const bal = () =>
    client.readContract({
      address: state.rwd as Address,
      abi: ERC20,
      functionName: "balanceOf",
      args: [state.author as Address],
    });

  const grant = {
    repoId: repoIdFromFullName(state.repoFullName),
    repoFullName: state.repoFullName,
    platform: "github",
    recipient: state.recipient,
    token: state.ptk,
    chain: "base",
    totalLocked: "0",
    totalPushesRequired: 2,
    pushesPerMilestone: 1,
    tokensPerMilestone: "0",
    verifiedPushCount: 0,
    lastPaidMilestone: 0,
    onChainTxHash: state.lockTx,
    installationId: 0,
    status: "active",
    streaming: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as GrantRecord;

  console.log("author RWD before:", formatUnits(await bal(), 18));
  const first = await payRewardForMerge({
    grant,
    repoId: grant.repoId,
    authorLogin: "testauthor",
    mergeCommitSha: MERGE_SHA,
  });
  console.log("first payRewardForMerge:", JSON.stringify(first));
  console.log("author RWD after 1st:", formatUnits(await bal(), 18));

  const second = await payRewardForMerge({
    grant,
    repoId: grant.repoId,
    authorLogin: "testauthor",
    mergeCommitSha: MERGE_SHA,
  });
  console.log("second payRewardForMerge (same merge):", JSON.stringify(second));
  console.log("author RWD after 2nd:", formatUnits(await bal(), 18));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
