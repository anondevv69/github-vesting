/**
 * TEST-ONLY Phase-B driver for the MULTI-GRANT suite: exercises the
 * REAL registration + status HTTP surface against the running
 * server (started by run-multigrant.sh with the post-cutover
 * config: GIT_ESCROW_ADDRESS=V3, GIT_ESCROW_V2_ADDRESS=V2):
 *
 *   repo2 = testowner/multigrant (fresh repo, counter pre-set to 7)
 *   - prepare-lock returns escrowVersion 3 + expectedGrantId, and
 *     the Locked event's grantId matches it (no competing lock);
 *   - V3 registration succeeds, records grantId + startPushCount 0
 *     from chain, and does NOT reset the repo counter (SET NX);
 *   - a second V3 registration succeeds beside the first (no 409);
 *   - a V2-escrow lock registration is refused 409 while grants
 *     are active (legacy one-grant rule intact);
 *   - status shapes: primary grant + grants[] for both repos,
 *     ?grantId= lock detail, /api/vesting/grant/:grantId.
 *
 * Then, on the Phase-A repo (all grants complete): two fresh V3
 * grants D + E are locked (baseline 100) and registered, the daily
 * counter key is cleared, and reviewer wallets are linked — the
 * shell drives the swarm-quorum webhook + reviews next.
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
import { REVONE_KEY, REVTWO_KEY } from "./swarm-keys";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra !== undefined ? ` (${String(extra)})` : ""}`);
  if (!cond) failures++;
}

const API = "http://127.0.0.1:3210";
const ERC20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const V3 = parseAbi([
  "function lock(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile) external returns (bytes32)",
  "event Locked(bytes32 indexed grantId, bytes32 indexed repoId, address indexed recipient, address token, uint256 amount, uint256 totalPushesRequired, uint256 releasesPerMilestone, uint256 tokensPerMilestone, uint256 startPushCount)",
]);
const V2 = parseAbi([
  "function lock(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile) external",
]);

async function main() {
  const state = JSON.parse(readFileSync(join(__dirname, "state-multigrant.json"), "utf8"));
  const E18 = 10n ** 18n;
  const repo2 = "testowner/multigrant";

  const { getRedis, KEYS } = await import("../../src/lib/redis");
  const { repoIdFromFullName } = await import("../../src/lib/repoId");
  const { prepareLockTransactions } = await import("../../src/lib/lockBuilder");
  const { addLinkedWallet } = await import("../../src/lib/devWallets");

  const redis = getRedis();
  const repo2Id = repoIdFromFullName(repo2);
  const repo1Id = repoIdFromFullName(state.repoFullName);
  await redis.set(KEYS.pushCount(repo2Id), "7");

  const recipientAcct = privateKeyToAccount(state.recipientKey as `0x${string}`);
  const client = createPublicClient({ chain: base, transport: http("http://127.0.0.1:8545") });
  const wallet = createWalletClient({ account: recipientAcct, chain: base, transport: http("http://127.0.0.1:8545") });

  async function lockV3(repoFullName: string, amount: bigint, totalPushes: bigint) {
    const rid = repoIdFromFullName(repoFullName);
    await wallet.writeContract({ address: state.ptk as Address, abi: ERC20, functionName: "approve", args: [state.v3 as Address, amount] });
    const hash = await wallet.writeContract({
      address: state.v3 as Address, abi: V3, functionName: "lock",
      args: [`0x${rid}` as `0x${string}`, state.ptk as Address, amount, totalPushes, 1n],
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi: V3, logs: receipt.logs, eventName: "Locked" })[0]!;
    return { hash, grantId: ev.args.grantId.toLowerCase(), startPushCount: Number(ev.args.startPushCount) };
  }

  async function register(repoFullName: string, lockTxHash: string, totalLocked: bigint, totalPushes: number, grantId?: string) {
    const res = await fetch(`${API}/api/vesting/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoFullName,
        platform: "github",
        recipient: state.recipient,
        token: state.ptk,
        chain: "base",
        totalLocked: totalLocked.toString(),
        totalPushesRequired: totalPushes,
        pushesPerMilestone: 1,
        tokensPerMilestone: (totalLocked / BigInt(totalPushes)).toString(),
        onChainTxHash: lockTxHash,
        installationId: 777,
        streaming: false,
        ...(grantId ? { grantId } : {}),
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, never> };
  }

  // ── prepare-lock: version + expectedGrantId.
  const prep = await prepareLockTransactions({
    wallet: state.recipient as Address,
    repoFullName: repo2,
    token: state.ptk as Address,
    amount: "100",
    totalPushes: 2,
    pushesPerMilestone: 1,
    chain: "base",
  });
  check("prepare-lock escrowVersion is 3", prep.escrowVersion === 3, String(prep.escrowVersion));
  check("prepare-lock expectedGrantId present", typeof prep.expectedGrantId === "string", prep.expectedGrantId);

  // ── V3 lock #1 on repo2 + registration.
  const lock1 = await lockV3(repo2, 100n * E18, 2n);
  check("expectedGrantId matches the Locked event grantId", lock1.grantId === prep.expectedGrantId?.toLowerCase(), `${lock1.grantId} vs ${prep.expectedGrantId}`);
  const reg1 = await register(repo2, lock1.hash, 100n * E18, 2, lock1.grantId);
  check("V3 registration #1 ok", reg1.status === 200 && reg1.body.ok === true, JSON.stringify(reg1.body).slice(0, 200));
  check("registration returns the recorded grantId", (reg1.body as { grantId?: string }).grantId === lock1.grantId);
  check("grant baseline recorded from chain (0)", (reg1.body as { grant?: { startPushCount?: number } }).grant?.startPushCount === 0);
  check("counter NOT reset by V3 registration (still 7)", (await redis.get(KEYS.pushCount(repo2Id))) === "7");

  // grantId cross-check: a wrong expected grantId is a hard error.
  const lockBad = await lockV3(repo2, 100n * E18, 2n);
  const regBad = await register(repo2, lockBad.hash, 100n * E18, 2, "0x" + "ff".repeat(32));
  check("grantId mismatch is a hard error (400)", regBad.status === 400, JSON.stringify(regBad.body).slice(0, 160));
  // …and the same lock registers fine with its real grantId (this is V3 grant #2).
  const reg2 = await register(repo2, lockBad.hash, 100n * E18, 2, lockBad.grantId);
  check("second V3 registration ok beside the first (no 409)", reg2.status === 200 && reg2.body.ok === true, JSON.stringify(reg2.body).slice(0, 160));
  check("second grantId differs from the first", lockBad.grantId !== lock1.grantId);
  check("counter still 7 after second registration", (await redis.get(KEYS.pushCount(repo2Id))) === "7");

  // ── V2-escrow lock on repo2: legacy rule still refuses (409).
  await wallet.writeContract({ address: state.ptk as Address, abi: ERC20, functionName: "approve", args: [state.v2 as Address, 100n * E18] });
  const lockV2Hash = await wallet.writeContract({
    address: state.v2 as Address, abi: V2, functionName: "lock",
    args: [`0x${repo2Id}` as `0x${string}`, state.ptk as Address, 100n * E18, 2n, 1n],
  });
  await client.waitForTransactionReceipt({ hash: lockV2Hash });
  const regV2 = await register(repo2, lockV2Hash, 100n * E18, 2);
  check("V2-escrow registration refused 409 while grants active", regV2.status === 409, JSON.stringify(regV2.body).slice(0, 160));

  // ── Status shapes.
  const st2 = (await (await fetch(`${API}/api/vesting/status?repo=${encodeURIComponent(repo2)}`)).json()) as {
    grants?: unknown[]; grant?: { grantId?: string };
  };
  check("repo2 status lists both V3 grants", Array.isArray(st2.grants) && st2.grants.length === 2, JSON.stringify(st2.grants)?.length);
  const st1 = (await (await fetch(`${API}/api/vesting/status?repo=${encodeURIComponent(state.repoFullName)}`)).json()) as {
    grants?: Array<{ grantId: string | null; startPushCount: number | null; verifiedPushCount: number; status: string }>;
    grant?: { grantId?: string };
  };
  check("repo1 status lists all 3 grants", Array.isArray(st1.grants) && st1.grants.length === 3, st1.grants?.length);
  check("repo1 primary is the most recent grant when none active (B)", st1.grant?.grantId?.toLowerCase() === state.grantIdB.toLowerCase(), st1.grant?.grantId);
  const entryB = st1.grants?.find((g) => g.grantId?.toLowerCase() === state.grantIdB.toLowerCase());
  check("repo1 entry B: baseline 10, grant-relative elapsed 90, complete", entryB?.startPushCount === 10 && entryB?.verifiedPushCount === 90 && entryB?.status === "complete", JSON.stringify(entryB));
  const detail = (await (await fetch(`${API}/api/vesting/lock/testowner/testrepo?grantId=${state.grantIdA}`)).json()) as {
    grant?: { grantId?: string }; grants?: unknown[];
  };
  check("lock detail ?grantId= selects grant A", detail.grant?.grantId?.toLowerCase() === state.grantIdA.toLowerCase(), detail.grant?.grantId);
  check("lock detail carries the grants array", Array.isArray(detail.grants) && detail.grants.length === 3);
  const byId = (await (await fetch(`${API}/api/vesting/grant/${state.grantIdB}`)).json()) as {
    grant?: { grantId?: string; totalLocked?: string }; entry?: { startPushCount?: number };
  };
  check("/api/vesting/grant/:grantId returns B with its baseline", byId.grant?.grantId?.toLowerCase() === state.grantIdB.toLowerCase() && byId.entry?.startPushCount === 10, JSON.stringify(byId).slice(0, 200));

  // ── Grants D + E on repo1 (baseline 100) for the swarm phase.
  const lockD = await lockV3(state.repoFullName, 200n * E18, 2n);
  check("grant D baseline stamps at 100", lockD.startPushCount === 100, String(lockD.startPushCount));
  const regD = await register(state.repoFullName, lockD.hash, 200n * E18, 2, lockD.grantId);
  check("grant D registers beside completed grants (no 409)", regD.status === 200 && regD.body.ok === true, JSON.stringify(regD.body).slice(0, 160));
  const lockE = await lockV3(state.repoFullName, 200n * E18, 2n);
  const regE = await register(state.repoFullName, lockE.hash, 200n * E18, 2, lockE.grantId);
  check("grant E registers beside active D (no 409)", regE.status === 200 && regE.body.ok === true, JSON.stringify(regE.body).slice(0, 160));
  check("repo1 counter still 100 after D/E registrations", (await redis.get(KEYS.pushCount(repo1Id))) === "100");

  // Swarm phase prep: clear today's daily-cap key (Phase A bypassed
  // the cap 100 times; the webhook path enforces it) and link the
  // reviewer wallets.
  const dailyKeys = await redis.keys(`vesting:daily:${repo1Id}:*`);
  for (const k of dailyKeys) await redis.del(k);
  const revone = privateKeyToAccount(REVONE_KEY).address;
  const revtwo = privateKeyToAccount(REVTWO_KEY).address;
  await addLinkedWallet("revone", revone, "signed");
  await addLinkedWallet("revtwo", revtwo, "signed");
  state.grantIdD = lockD.grantId;
  state.grantIdE = lockE.grantId;
  state.revone = revone;
  state.revtwo = revtwo;
  writeFileSync(join(__dirname, "state-multigrant.json"), JSON.stringify(state, null, 2));
  console.log(`SWARM_READY D=${lockD.grantId} E=${lockE.grantId} revone=${revone} revtwo=${revtwo}`);

  console.log(failures === 0 ? "MULTIGRANT REGISTER: ALL PASS" : `MULTIGRANT REGISTER: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
