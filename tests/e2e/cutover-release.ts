/**
 * v1→v2 cutover driver: proves the backend release path services
 * each grant through the escrow it was created under AFTER the
 * chain config has been repointed at v2.
 *
 * Setup (deploy-cutover.ts): GitEscrow v1 holds the legacy grant,
 * GitEscrowV2 holds the new grant. This driver configures the
 * backend exactly as production will run post-cutover:
 *   GIT_ESCROW_ADDRESS        = v2   (the repoint)
 *   GIT_ESCROW_LEGACY_ADDRESS = v1   (where existing grants live)
 * and then:
 *   1. resolver unit checks (stored escrow wins; Base grant without
 *      a stored escrow → legacy; Robinhood grant without one → its
 *      configured escrow, unchanged behaviour);
 *   2. a grant record WITHOUT escrowAddress (the pre-cutover
 *      production shape) releases from V1 — recipient paid, v1
 *      escrow drained by the milestone amount, v2 untouched;
 *   3. a grant record WITH escrowAddress = v2 releases from V2.
 *
 * Run via tests/e2e/run-cutover.sh (sets the env + local stack).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { createPublicClient, http, parseAbi, formatEther } from "viem";
import { base } from "viem/chains";
import type { GrantRecord } from "../../src/lib/redis";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra !== undefined ? ` (${String(extra)})` : ""}`);
  if (!cond) failures++;
}

async function main() {
  const state = JSON.parse(readFileSync(join(__dirname, "state-cutover.json"), "utf8"));

  // Backend modules are imported only after the runner has set the
  // production-shaped env (src/lib/env reads process.env at import).
  const { resolveGrantEscrowAddress } = await import("../../src/lib/chains");
  const { saveGrant, getGrant } = await import("../../src/lib/redis");
  const { triggerReleaseIfMilestone } = await import("../../src/oracle/releaseOracle");

  // ── 1. Resolver unit checks ──────────────────────────────────────
  check(
    "resolver: stored escrow wins over config + legacy",
    resolveGrantEscrowAddress({ chain: "base", escrowAddress: state.v2 }) === state.v2,
  );
  check(
    "resolver: Base grant without stored escrow → legacy escrow",
    resolveGrantEscrowAddress({ chain: "base" })?.toLowerCase() === state.v1.toLowerCase(),
    resolveGrantEscrowAddress({ chain: "base" }),
  );
  check(
    "resolver: Robinhood grant without stored escrow → configured RH escrow (unchanged)",
    resolveGrantEscrowAddress({ chain: "robinhood" }) ===
      "0x706038b47ba6d0CC69479bB286d064137B50f6Ae",
  );

  // ── Grant records (production shapes) ────────────────────────────
  const baseRecord = {
    repoFullName: "",
    platform: "github" as const,
    token: state.token,
    chain: "base" as const,
    totalLocked: "1000000000000000000000",
    totalPushesRequired: 2,
    pushesPerMilestone: 1,
    tokensPerMilestone: "500000000000000000000",
    verifiedPushCount: 0,
    lastPaidMilestone: 0,
    installationId: 0,
    status: "active" as const,
    streaming: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // Pre-cutover shape: NO escrowAddress recorded.
  const legacyGrant: GrantRecord = {
    ...baseRecord,
    repoId: state.legacyRepoId,
    repoFullName: "cutover/legacy-repo",
    recipient: state.legacyRecipient,
    onChainTxHash: state.lockTxV1,
  };
  // Post-cutover shape: registration recorded the emitting escrow.
  const v2Grant: GrantRecord = {
    ...baseRecord,
    repoId: state.v2RepoId,
    repoFullName: "cutover/v2-repo",
    recipient: state.v2Recipient,
    onChainTxHash: state.lockTxV2,
    escrowAddress: state.v2,
  };
  await saveGrant(legacyGrant);
  await saveGrant(v2Grant);

  const client = createPublicClient({ chain: base, transport: http("http://127.0.0.1:8545") });
  const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const bal = (a: string) =>
    client.readContract({ address: state.token, abi: ERC20, functionName: "balanceOf", args: [a as `0x${string}`] });

  // ── 2. Legacy grant releases from V1 after the repoint ───────────
  const v1Before = await bal(state.v1);
  const v2Before = await bal(state.v2);
  const legacyRecipBefore = await bal(state.legacyRecipient);
  const legacyResult = await triggerReleaseIfMilestone(state.legacyRepoId, legacyGrant, 1);
  check("legacy release triggered", legacyResult.triggered === true, JSON.stringify(legacyResult));
  check(
    "legacy recipient paid 500 CTT",
    (await bal(state.legacyRecipient)) - legacyRecipBefore === 500n * 10n ** 18n,
    formatEther(await bal(state.legacyRecipient)),
  );
  check(
    "v1 escrow paid out the milestone",
    v1Before - (await bal(state.v1)) === 500n * 10n ** 18n,
  );
  check("v2 escrow untouched by legacy release", (await bal(state.v2)) === v2Before);
  const legacyAfter = await getGrant(state.legacyRepoId);
  check("legacy grant milestone recorded", legacyAfter?.lastPaidMilestone === 1);

  // ── 3. V2 grant releases from V2 ─────────────────────────────────
  const v2RecipBefore = await bal(state.v2Recipient);
  const v2Result = await triggerReleaseIfMilestone(state.v2RepoId, v2Grant, 1);
  check("v2 release triggered", v2Result.triggered === true, JSON.stringify(v2Result));
  check(
    "v2 recipient paid 500 CTT from v2",
    (await bal(state.v2Recipient)) - v2RecipBefore === 500n * 10n ** 18n,
  );
  check(
    "v2 escrow paid out the milestone",
    v2Before - (await bal(state.v2)) === 500n * 10n ** 18n,
  );
  const v2After = await getGrant(state.v2RepoId);
  check("v2 grant milestone recorded", v2After?.lastPaidMilestone === 1);

  console.log(failures === 0 ? "CUTOVER: ALL PASS" : `CUTOVER: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
