import type { GrantRecord } from "../lib/redis";
import { updateGrant } from "../lib/redis";
import { verifyPush, recordVerifiedPush, recordRejectedPush, type PushPayload } from "./pushVerifier";
import { triggerReleaseIfMilestone } from "../oracle/releaseOracle";

export type PushProcessResult = {
  accepted: boolean;
  reason: string;
  verifiedPushCount?: number;
  release?: Awaited<ReturnType<typeof triggerReleaseIfMilestone>>;
};

/** Shared push → verify → count → optional release flow (webhook + dev simulate). */
export async function processPushForGrant(
  grant: GrantRecord,
  payload: PushPayload,
  options?: { bypassCooldown?: boolean; platform?: "github" | "gitlawb" },
): Promise<PushProcessResult> {
  const repoId = grant.repoId;
  const platform = options?.platform ?? grant.platform ?? "github";
  const verifyResult = await verifyPush(repoId, payload, { ...options, platform });

  if (!verifyResult.accepted) {
    await recordRejectedPush(repoId, payload, verifyResult);
    return { accepted: false, reason: verifyResult.reason };
  }

  const newPushCount = await recordVerifiedPush(repoId, payload, verifyResult);
  await updateGrant(repoId, { verifiedPushCount: newPushCount });
  const release = await triggerReleaseIfMilestone(repoId, grant, newPushCount);

  return {
    accepted: true,
    reason: verifyResult.reason,
    verifiedPushCount: newPushCount,
    release,
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
