import type { GrantRecord } from "../lib/redis";
import { updateGrant } from "../lib/redis";
import { verifyPush, recordVerifiedPush, recordRejectedPush, type PushPayload } from "./pushVerifier";
import { resolveMergedPrCredit, type MergedPrCredit } from "./prCredit";
import { triggerReleaseIfMilestone } from "../oracle/releaseOracle";
import { payRewardForMerge, type RewardResult } from "../oracle/shipRewards";

export type PushProcessResult = {
  accepted: boolean;
  reason: string;
  verifiedPushCount?: number;
  release?: Awaited<ReturnType<typeof triggerReleaseIfMilestone>>;
  /** Set when the counted push was credited to a merged PR (Ship spec §8). */
  prCredit?: { prNumber: number; authorLogin: string };
  /** Per-merge Ship reward outcome (spec §8B) — only for PR-credited pushes. */
  reward?: RewardResult;
};

/** Shared push → verify → count → optional release flow (webhook + dev simulate). */
export async function processPushForGrant(
  grant: GrantRecord,
  payload: PushPayload,
  options?: { bypassCooldown?: boolean; bypassDailyCap?: boolean; platform?: "github" | "gitlawb" },
): Promise<PushProcessResult> {
  const repoId = grant.repoId;
  const platform = options?.platform ?? grant.platform ?? "github";

  // Ship PR-credit (§8): a merged PR is evaluated on the PR's own diff/author
  // and normalised to a single commit, so one merge counts at most once.
  // Non-PR pushes (and any PR-lookup failure) keep the legacy raw-push flow.
  let prCredit: MergedPrCredit | null = null;
  let effectivePayload = payload;
  let linesOverride: number | undefined;
  if (platform === "github") {
    prCredit = await resolveMergedPrCredit(grant.repoFullName, payload, grant.installationId);
    if (prCredit) {
      effectivePayload = prCredit.payload;
      linesOverride = prCredit.linesChanged;
    }
  }

  const verifyResult = await verifyPush(repoId, effectivePayload, {
    ...options,
    platform,
    ...(linesOverride !== undefined ? { linesOverride } : {}),
  });

  if (!verifyResult.accepted) {
    await recordRejectedPush(repoId, effectivePayload, verifyResult);
    return { accepted: false, reason: verifyResult.reason };
  }

  const newPushCount = await recordVerifiedPush(repoId, effectivePayload, verifyResult);
  await updateGrant(repoId, { verifiedPushCount: newPushCount });
  const release = await triggerReleaseIfMilestone(repoId, grant, newPushCount);

  // Ship dual reward (§8B): every counted merged PR also pays the flat
  // per-merge reward to the PR author's linked wallet. Safely no-ops when
  // ShipRewards is not configured, the amount is 0, or no wallet is linked.
  let reward: RewardResult | undefined;
  if (prCredit) {
    reward = await payRewardForMerge({
      grant,
      repoId,
      authorLogin: prCredit.authorLogin,
      mergeCommitSha: prCredit.mergeCommitSha,
    });
  }

  return {
    accepted: true,
    reason: verifyResult.reason,
    verifiedPushCount: newPushCount,
    release,
    ...(prCredit
      ? { prCredit: { prNumber: prCredit.prNumber, authorLogin: prCredit.authorLogin } }
      : {}),
    ...(reward ? { reward } : {}),
  };
}

export function buildDevPushPayload(repoFullName: string, sha?: string): PushPayload {
  const id = sha ?? `dev${Date.now().toString(16)}`.padEnd(40, "0").slice(0, 40);
  return {
    ref: "refs/heads/main",
    forced: false,
    commits: [
      {
        id,
        message: "feat: verified code change for vesting milestone",
        added: ["src/vesting/feature.ts"],
        removed: [],
        modified: ["src/vesting/core.ts", "src/vesting/util.ts"],
        timestamp: new Date().toISOString(),
      },
    ],
    repository: { full_name: repoFullName },
    pusher: { name: "dev-simulator" },
  };
}
