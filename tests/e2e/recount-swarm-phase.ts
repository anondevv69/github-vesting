/**
 * TEST-ONLY (run-recount.sh step 15): swarm-gated recount history,
 * driven through the REAL swarm gate + REAL record functions (the
 * same calls processPush makes), then recounted with the REAL
 * recount. History for testowner/swarmrecount:
 *   push A: 2 independent PASS reviews -> gate met -> COUNTED
 *           (recordVerifiedPush with the swarm verdict stamped on)
 *   push B: 1 FAIL review -> gate vetoed -> recorded as a rejection
 *           carrying the swarm verdict (met=false)
 *   push C: no reviews -> gate unmet -> recorded as a rejection
 *           carrying the swarm verdict (met=false)
 * The recount must equal the webhook total (1): replaying raw
 * verifier rules alone would count B and C too — the recorded swarm
 * decisions are what keep them out.
 */
import { addLinkedWallet } from "../../src/lib/devWallets";
import {
  enrollReviewer,
  submitReview,
  evaluateSwarmGate,
  recordCountedFingerprint,
  computeDiffFingerprint,
} from "../../src/lib/swarmReview";
import {
  recordVerifiedPush,
  recordRejectedPush,
  type PushPayload,
} from "../../src/github/pushVerifier";
import { recountEligiblePushes, writePushCheckpoint } from "../../src/lib/recount";
import { repoIdFromFullName } from "../../src/lib/repoId";

const REPO = "testowner/swarmrecount";
const AUTHOR = "testauthor";
const REV1 = "revone";
const REV2 = "revtwo";
const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";

function payload(sha: string): PushPayload {
  return {
    ref: "refs/heads/main",
    forced: false,
    after: sha,
    commits: [
      {
        id: sha,
        message: "feat: swarm recounted change",
        added: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
        removed: [],
        modified: [],
        timestamp: new Date().toISOString(),
      },
    ],
    repository: { full_name: REPO },
    pusher: { name: AUTHOR },
    sender: { login: AUTHOR, type: "User" },
  };
}

const fp = (seed: string) =>
  computeDiffFingerprint([
    { filename: "src/a.ts", status: "added", additions: 10, deletions: 0, patch: `@@ ${seed} @@` },
    { filename: "src/b.ts", status: "modified", additions: 5, deletions: 1, patch: `@@ ${seed} b @@` },
  ]);

async function main() {
  const repoId = repoIdFromFullName(REPO);
  await addLinkedWallet(REV1, W1, "signed");
  await addLinkedWallet(REV2, W2, "signed");
  const e1 = await enrollReviewer({ githubLogin: REV1, wallet: W1 });
  const e2 = await enrollReviewer({ githubLogin: REV2, wallet: W2 });
  if (!e1.ok || !e2.ok) throw new Error("reviewer enrolment failed");

  const shaA = "aa".repeat(20);
  const shaB = "bb".repeat(20);
  const shaC = "cc".repeat(20);

  // Push A — two independent PASS reviews, gate met, counted.
  const fpA = fp("alpha");
  await submitReview({ repo: REPO, headSha: shaA, reviewerLogin: REV1, verdict: "pass", different: true, meaningful: true, checksPass: true, fingerprint: fpA });
  await submitReview({ repo: REPO, headSha: shaA, reviewerLogin: REV2, verdict: "pass", different: true, meaningful: true, checksPass: true, fingerprint: fpA });
  const gateA = await evaluateSwarmGate({ repo: REPO, headSha: shaA, authorLogin: AUTHOR, fingerprint: fpA });
  if (!gateA.ok) throw new Error(`gate A should pass: ${gateA.reason}`);
  const claimA = await recordVerifiedPush(repoId, payload(shaA), { accepted: true, reason: "swarm phase A", linesEstimate: 25 }, {
    bypassCooldown: true,
    bypassDailyCap: true,
    swarm: { required: true, fingerprint: fpA, passCount: gateA.quorum.passCount, failCount: gateA.quorum.failCount, duplicateFlagged: gateA.quorum.duplicateFlagged, met: true },
  });
  if (!("total" in claimA)) throw new Error(`push A claim failed: ${JSON.stringify(claimA)}`);
  await recordCountedFingerprint(REPO, shaA, fpA);
  await writePushCheckpoint(repoId, REPO, claimA.total);

  // Push B — one FAIL review vetoes it; recorded as a swarm rejection.
  const fpB = fp("bravo");
  await submitReview({ repo: REPO, headSha: shaB, reviewerLogin: REV1, verdict: "fail", different: false, meaningful: true, checksPass: true, fingerprint: fpB });
  const gateB = await evaluateSwarmGate({ repo: REPO, headSha: shaB, authorLogin: AUTHOR, fingerprint: fpB });
  if (gateB.ok) throw new Error("gate B should be vetoed by the FAIL");
  await recordRejectedPush(repoId, payload(shaB), { accepted: false, reason: gateB.reason, linesEstimate: 25 }, {
    swarm: { required: true, fingerprint: fpB, passCount: gateB.quorum.passCount, failCount: gateB.quorum.failCount, duplicateFlagged: gateB.quorum.duplicateFlagged, met: false },
  });

  // Push C — no reviews; gate unmet; recorded as a swarm rejection.
  const fpC = fp("charlie");
  const gateC = await evaluateSwarmGate({ repo: REPO, headSha: shaC, authorLogin: AUTHOR, fingerprint: fpC });
  if (gateC.ok) throw new Error("gate C should be unmet without reviews");
  await recordRejectedPush(repoId, payload(shaC), { accepted: false, reason: gateC.reason, linesEstimate: 25 }, {
    swarm: { required: true, fingerprint: fpC, passCount: gateC.quorum.passCount, failCount: gateC.quorum.failCount, duplicateFlagged: gateC.quorum.duplicateFlagged, met: false },
  });

  const recount = await recountEligiblePushes(repoId);
  console.log(JSON.stringify({
    phase: "swarm",
    recordedCount: recount.recordedCount,
    recountedCount: recount.recountedCount,
    status: recount.status,
    decisions: recount.decisions.map((d) => ({ sha: d.sha.slice(0, 6), counted: d.counted, reason: d.reason })),
  }));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
