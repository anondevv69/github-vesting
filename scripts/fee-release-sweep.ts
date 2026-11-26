/**
 * Fee-release keeper sweep (Codex round-2): retry every durable
 * pending fee release recorded by src/oracle/feeLock.ts when a
 * counted push's fee release failed after its supply release
 * succeeded. A successful retry pays the vested fee tranches exactly
 * once (releaseFee is cumulative/idempotent on-chain) and clears the
 * pending entry; the supply release is never re-run.
 *
 * Usage: npx tsx scripts/fee-release-sweep.ts
 */
import { sweepPendingFeeReleases } from "../src/oracle/feeLock";

async function main() {
  const results = await sweepPendingFeeReleases();
  for (const r of results) {
    console.log(`SWEEP ${JSON.stringify({ repo: r.repoFullName, ...r.result })}`);
  }
  console.log(JSON.stringify({ swept: results.length, results }));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
