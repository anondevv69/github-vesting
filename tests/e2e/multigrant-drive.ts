/**
 * TEST-ONLY Phase-A driver for the MULTI-GRANT suite: three grants
 * on one repo / one counter, driven through the REAL backend push
 * pipeline (processPushForGrant with cap/cooldown bypass — the
 * verifier's daily cap of 3 makes 100 webhook pushes impossible in
 * a day; the swarm window is pinned to 0 so pushes settle by
 * verifier fallback, as in run-recount.sh).
 *
 *   legacy V2: 10,000 PTK, 100/1 — beside the V3 grants
 *   V3 grant A: 10,000 PTK, 100/1 — baseline 0
 *   V3 grant B:  5,000 PTK,  50/1 — locked after push 10, baseline 10
 *
 * Push 1 is a PR-credited merge (fixture PR #42): the author reward
 * must land EXACTLY ONCE even though two grants vest on it.
 * B completes at repo total 60 while A + legacy run on to 100
 * (completion isolation).
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra !== undefined ? ` (${String(extra)})` : ""}`);
  if (!cond) failures++;
}

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const V3 = parseAbi([
  "function lock(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile) external returns (bytes32)",
  "function getGrant(bytes32 grantId) view returns ((bytes32 repoId, address recipient, address token, uint256 totalLocked, uint256 totalReleased, uint256 totalPushesRequired, uint256 pushesPerMilestone, uint256 tokensPerMilestone, uint256 lastPaidMilestone, bool active, bool streaming, uint64 lockedAt, uint256 startPushCount))",
  "event Locked(bytes32 indexed grantId, bytes32 indexed repoId, address indexed recipient, address token, uint256 amount, uint256 totalPushesRequired, uint256 releasesPerMilestone, uint256 tokensPerMilestone, uint256 startPushCount)",
]);

async function main() {
  const state = JSON.parse(readFileSync(join(__dirname, "state-multigrant.json"), "utf8"));
  const E18 = 10n ** 18n;

  const { saveGrant, saveGrantById, getGrantById, getGrant, getRedis, KEYS } = await import(
    "../../src/lib/redis"
  );
  const { addLinkedWallet } = await import("../../src/lib/devWallets");
  const { processPushForGrant, buildDevPushPayload } = await import("../../src/github/processPush");
  const { repoIdFromFullName } = await import("../../src/lib/repoId");

  const repoId = repoIdFromFullName(state.repoFullName);
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 10).toISOString();
  const baseRec = {
    repoId,
    repoFullName: state.repoFullName,
    platform: "github" as const,
    recipient: state.recipient,
    token: state.ptk,
    chain: "base" as const,
    verifiedPushCount: 0,
    lastPaidMilestone: 0,
    installationId: 777,
    status: "active" as const,
    streaming: false,
  };
  await saveGrant({
    ...baseRec,
    totalLocked: (10000n * E18).toString(),
    totalPushesRequired: 100,
    pushesPerMilestone: 1,
    tokensPerMilestone: (100n * E18).toString(),
    onChainTxHash: state.lockTxV2,
    escrowAddress: state.v2,
    escrowVersion: 2,
    createdAt: now,
    updatedAt: now,
  });
  await saveGrantById({
    ...baseRec,
    totalLocked: (10000n * E18).toString(),
    totalPushesRequired: 100,
    pushesPerMilestone: 1,
    tokensPerMilestone: (100n * E18).toString(),
    onChainTxHash: state.lockTxV3A,
    escrowAddress: state.v3,
    escrowVersion: 3,
    grantId: state.grantIdA,
    startPushCount: 0,
    createdAt: later,
    updatedAt: later,
  });
  await addLinkedWallet("testauthor", state.author, "signed");

  const client = createPublicClient({ chain: base, transport: http("http://127.0.0.1:8545") });
  const bal = (token: string, who: string) =>
    client.readContract({ address: token as Address, abi: ERC20, functionName: "balanceOf", args: [who as Address] });

  const primary = await getGrant(repoId);
  if (!primary) throw new Error("primary grant missing after seed");

  const push = async (n: number) => {
    const payload =
      n === 1
        ? {
            ref: "refs/heads/main",
            forced: false,
            commits: [
              {
                id: "c0ffee0000000000000000000000000000000042",
                message: "feat: shiny thing (#42)",
                added: Array.from({ length: 11 }, (_, i) => `src/feature/p${i + 1}.ts`),
                removed: [],
                modified: [],
                timestamp: new Date().toISOString(),
              },
            ],
            repository: { full_name: state.repoFullName },
            pusher: { name: "testdev" },
          }
        : buildDevPushPayload(state.repoFullName, n.toString(16).padStart(40, "0"));
    const result = await processPushForGrant(primary, payload as never, {
      bypassCooldown: true,
      bypassDailyCap: true,
    });
    if (!result.accepted) throw new Error(`push ${n} not counted: ${result.reason}`);
    return result;
  };

  // ── Push 1: PR-credited — author reward exactly once, both grants vest.
  const r1 = await push(1);
  check("push 1 counted via PR credit", r1.prCredit?.prNumber === 42, JSON.stringify(r1.prCredit));
  check("author reward paid on push 1", r1.reward?.paid === true, JSON.stringify(r1.reward));
  check("author RWD balance is exactly 10 after push 1", (await bal(state.rwd, state.author)) === 10n * E18);
  check(
    "recipient gained 100 (legacy) + 100 (A) on push 1",
    (await bal(state.ptk, state.recipient)) === 100000n * E18 - 20000n * E18 + 200n * E18,
    (await bal(state.ptk, state.recipient)).toString(),
  );

  // ── Pushes 2..10.
  for (let n = 2; n <= 10; n++) await push(n);
  const aOnChain10 = await client.readContract({
    address: state.v3 as Address, abi: V3, functionName: "getGrant", args: [state.grantIdA as `0x${string}`],
  });
  check("grant A released 1000 PTK after 10 pushes", aOnChain10.totalReleased === 1000n * E18, aOnChain10.totalReleased.toString());

  // ── Lock grant B now: baseline must stamp at knownPushCount = 10.
  const recipientAcct = privateKeyToAccount(state.recipientKey as `0x${string}`);
  check("recipient key matches deploy recipient", recipientAcct.address.toLowerCase() === state.recipient.toLowerCase());
  const wallet = createWalletClient({ account: recipientAcct, chain: base, transport: http("http://127.0.0.1:8545") });
  await wallet.writeContract({ address: state.ptk as Address, abi: ERC20, functionName: "approve", args: [state.v3 as Address, 5000n * E18] });
  const lockHash = await wallet.writeContract({
    address: state.v3 as Address,
    abi: V3,
    functionName: "lock",
    args: [`0x${repoId}` as `0x${string}`, state.ptk as Address, 5000n * E18, 50n, 1n],
  });
  const lockReceipt = await client.waitForTransactionReceipt({ hash: lockHash });
  const lockedEvents = parseEventLogs({ abi: V3, logs: lockReceipt.logs, eventName: "Locked" });
  const grantIdB = lockedEvents[0]!.args.grantId.toLowerCase();
  const bOnChain = await client.readContract({
    address: state.v3 as Address, abi: V3, functionName: "getGrant", args: [grantIdB as `0x${string}`],
  });
  check("grant B baseline stamped at 10 (reportCount/release-carried)", Number(bOnChain.startPushCount) === 10, bOnChain.startPushCount.toString());
  await saveGrantById({
    ...baseRec,
    totalLocked: (5000n * E18).toString(),
    totalPushesRequired: 50,
    pushesPerMilestone: 1,
    tokensPerMilestone: (100n * E18).toString(),
    onChainTxHash: lockHash,
    escrowAddress: state.v3,
    escrowVersion: 3,
    grantId: grantIdB,
    startPushCount: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  state.grantIdB = grantIdB;
  state.lockTxV3B = lockHash;
  writeFileSync(join(__dirname, "state-multigrant.json"), JSON.stringify(state, null, 2));

  // ── Pushes 11..60: B completes at repo total 60; A + legacy continue.
  for (let n = 11; n <= 60; n++) await push(n);
  const bRec60 = await getGrantById(grantIdB);
  check("grant B complete at repo total 60", bRec60?.status === "complete" && bRec60?.lastPaidMilestone === 50, JSON.stringify({ status: bRec60?.status, m: bRec60?.lastPaidMilestone }));
  const bChain60 = await client.readContract({
    address: state.v3 as Address, abi: V3, functionName: "getGrant", args: [grantIdB as `0x${string}`],
  });
  check("grant B fully released on-chain (5000) and inactive", bChain60.totalReleased === 5000n * E18 && bChain60.active === false);
  const aRec60 = await getGrantById(state.grantIdA);
  check("grant A still active at 60 with 60 milestones", aRec60?.status === "active" && aRec60?.lastPaidMilestone === 60, JSON.stringify({ status: aRec60?.status, m: aRec60?.lastPaidMilestone }));
  const legacyRec60 = await getGrant(repoId);
  check("legacy grant still active at 60 with 60 milestones", legacyRec60?.status === "active" && legacyRec60?.lastPaidMilestone === 60 && legacyRec60?.verifiedPushCount === 60, JSON.stringify({ status: legacyRec60?.status, m: legacyRec60?.lastPaidMilestone, c: legacyRec60?.verifiedPushCount }));

  // ── Pushes 61..100: A + legacy complete; nothing double-pays.
  for (let n = 61; n <= 100; n++) await push(n);
  const aRec100 = await getGrantById(state.grantIdA);
  const legacyRec100 = await getGrant(repoId);
  check("grant A complete at 100", aRec100?.status === "complete" && aRec100?.lastPaidMilestone === 100);
  check("legacy grant complete at 100", legacyRec100?.status === "complete" && legacyRec100?.lastPaidMilestone === 100);
  check("recipient balance fully restored (100,000 PTK — every lock paid out exactly)", (await bal(state.ptk, state.recipient)) === 100000n * E18, (await bal(state.ptk, state.recipient)).toString());
  check("V2 escrow drained", (await bal(state.ptk, state.v2)) === 0n);
  check("V3 escrow drained", (await bal(state.ptk, state.v3)) === 0n);
  check("author RWD still exactly 10 (reward never multiplied by grants)", (await bal(state.rwd, state.author)) === 10n * E18);
  const counter = await getRedis().get(KEYS.pushCount(repoId));
  check("repo counter is exactly 100 (counted once per push)", counter === "100", counter ?? "null");

  console.log(failures === 0 ? "MULTIGRANT DRIVE: ALL PASS" : `MULTIGRANT DRIVE: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
