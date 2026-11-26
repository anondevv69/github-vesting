/**
 * TEST-ONLY (run-fee-lock.sh steps 20-24): fee-release retry driver.
 *
 *   npx tsx tests/e2e/fee-retry.ts push <sha>   — run ONE counted push
 *     through the real processPushForGrant for the fee suite's grant.
 *     The DRIVER's env decides whether the fee leg works:
 *     FEE_STREAM_ESCROW_ADDRESS=<the GitEscrow address> makes every
 *     releaseFee call revert (no such function there) while the
 *     supply release — a different contract — succeeds. That is the
 *     Codex round-2 scenario exactly: supply paid, fee failed.
 *   npx tsx tests/e2e/fee-retry.ts pending      — print the durable
 *     pending-fee-release entry for the grant (or null).
 */
import * as fs from "fs";
import * as path from "path";
import { getGrant } from "../../src/lib/redis";
import { repoIdFromFullName } from "../../src/lib/repoId";
import { processPushForGrant, buildDevPushPayload } from "../../src/github/processPush";
import { getPendingFeeRelease } from "../../src/oracle/feeLock";

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state-fee.json"), "utf8"));
  const repoId = repoIdFromFullName(state.repoFullName);
  const grant = await getGrant(repoId);
  if (!grant) throw new Error("fee-suite grant not seeded");

  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "push") {
    const payload = buildDevPushPayload(state.repoFullName, arg);
    const result = await processPushForGrant(grant, payload, {
      bypassCooldown: true,
      bypassDailyCap: true,
    });
    const pending = await getPendingFeeRelease(repoId);
    console.log(JSON.stringify({ mode: "push", result, pending }));
  } else if (cmd === "pending") {
    console.log(JSON.stringify({ mode: "pending", pending: await getPendingFeeRelease(repoId) }));
  } else {
    throw new Error("usage: fee-retry.ts push <sha> | pending");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
