/**
 * TEST-ONLY: print a repo's push counter + push-log reasons from
 * Redis as one JSON line (concurrency driver assertions).
 *   npx tsx tests/e2e/push-state.ts <owner/repo>
 */
import { getRedis, KEYS } from "../../src/lib/redis";
import { repoIdFromFullName } from "../../src/lib/repoId";

async function main() {
  const repo = process.argv[2];
  if (!repo) throw new Error("usage: push-state.ts <owner/repo>");
  const repoId = repoIdFromFullName(repo);
  const redis = getRedis();
  const pushCount = parseInt((await redis.get(KEYS.pushCount(repoId))) ?? "0", 10);
  const raw = await redis.lrange(KEYS.pushLog(repoId), 0, -1);
  const log = raw.map((line) => {
    try {
      const e = JSON.parse(line) as { sha?: string; accepted?: boolean; reason?: string };
      return { sha: (e.sha ?? "").slice(0, 7), accepted: e.accepted !== false, reason: e.reason ?? "" };
    } catch {
      return { sha: "?", accepted: false, reason: "malformed" };
    }
  });
  console.log(JSON.stringify({ repo, pushCount, log }));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
