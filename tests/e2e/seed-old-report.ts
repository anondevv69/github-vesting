/**
 * TEST-ONLY: seed a ship report whose reportedAt is 25h ago, directly via
 * the repo's own Redis layer, so the attestation driver can exercise the
 * lazy-expiry path of GET /api/agent/ship-report without waiting 24h.
 * The record shape matches ShipReportRecord in src/api/shipReport.ts.
 */
import { getRedis, KEYS } from "../../src/lib/redis";

const SHA = "01d000000000000000000000000000000000000077".padEnd(40, "0").slice(0, 40);

async function main() {
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const record = {
    repo: "testowner/testrepo",
    headSha: SHA,
    state: "reported",
    reportedAt: old,
    updatedAt: old,
  };
  await getRedis().set(
    KEYS.shipReport(record.repo, record.headSha),
    JSON.stringify(record),
    "EX",
    48 * 60 * 60,
  );
  console.log(`seeded stale report ${record.repo}@${SHA} reportedAt=${old}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
