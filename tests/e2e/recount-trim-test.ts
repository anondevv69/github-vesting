/**
 * TEST-ONLY (run-recount.sh step 16): trimmed-log recount behaviour.
 *   - Five pushes counted for testowner/trimrecount through the real
 *     claim (bypasses on, substantial lines), a checkpoint written
 *     after every one (the webhook path's behaviour).
 *   - The push log is then LTRIMmed to its last entry (the 200-entry
 *     trim, compressed): a genesis replay now undercounts (1 != 5).
 *   - WITH the checkpoint: the recount certifies 5, starting from the
 *     checkpoint (checkpointUsed=true).
 *   - The checkpoint is deleted and the recount runs again: it must
 *     REFUSE — status "incomplete", recountedCount null — never an
 *     estimated total.
 */
import { getRedis, KEYS } from "../../src/lib/redis";
import { recordVerifiedPush, type PushPayload } from "../../src/github/pushVerifier";
import { recountEligiblePushes, writePushCheckpoint } from "../../src/lib/recount";
import { repoIdFromFullName } from "../../src/lib/repoId";

const REPO = "testowner/trimrecount";

function payload(sha: string): PushPayload {
  return {
    ref: "refs/heads/main",
    forced: false,
    after: sha,
    commits: [
      {
        id: sha,
        message: "feat: trim test change",
        added: ["src/a.ts", "src/b.ts", "src/c.ts"],
        removed: [],
        modified: [],
        timestamp: new Date().toISOString(),
      },
    ],
    repository: { full_name: REPO },
    pusher: { name: "testdev" },
    sender: { login: "testdev", type: "User" },
  };
}

async function main() {
  const repoId = repoIdFromFullName(REPO);
  const redis = getRedis();

  for (let i = 1; i <= 5; i++) {
    const sha = `f${i}`.padEnd(40, "0");
    const claim = await recordVerifiedPush(
      repoId,
      payload(sha),
      { accepted: true, reason: `trim seed ${i}`, linesEstimate: 100 },
      { bypassCooldown: true, bypassDailyCap: true },
    );
    if (!("total" in claim)) throw new Error(`seed push ${i} failed: ${JSON.stringify(claim)}`);
    await writePushCheckpoint(repoId, REPO, claim.total);
  }

  // Compress the 200-entry trim: keep only the last log entry.
  await redis.ltrim(KEYS.pushLog(repoId), -1, -1);

  const withCheckpoint = await recountEligiblePushes(repoId);
  console.log(JSON.stringify({
    phase: "trimmed-with-checkpoint",
    recordedCount: withCheckpoint.recordedCount,
    recountedCount: withCheckpoint.recountedCount,
    status: withCheckpoint.status,
    checkpointUsed: withCheckpoint.checkpointUsed,
  }));

  await redis.del(KEYS.pushCheckpoint(repoId));
  const without = await recountEligiblePushes(repoId);
  console.log(JSON.stringify({
    phase: "trimmed-without-checkpoint",
    recordedCount: without.recordedCount,
    recountedCount: without.recountedCount,
    status: without.status,
    checkpointUsed: without.checkpointUsed,
  }));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
