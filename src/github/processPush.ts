import type { GrantRecord } from "../lib/redis";
import { updateGrant, getRedis, KEYS } from "../lib/redis";
import { verifyPush, recordVerifiedPush, recordRejectedPush, type PushPayload } from "./pushVerifier";
import { resolveMergedPrCredit, type MergedPrCredit } from "./prCredit";
import { triggerReleaseIfMilestone } from "../oracle/releaseOracle";
import { payRewardForMerge, type RewardResult } from "../oracle/shipRewards";
import { repoIdFromFullName } from "../lib/repoId";

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

type EvaluatedPush =
  | { accepted: false; reason: string }
  | {
      accepted: true;
      reason: string;
      verifiedPushCount: number;
      prCredit: MergedPrCredit | null;
    };

/**
 * The shared core of both push paths: PR-credit resolution → verifier →
 * record. The verifier's anti-gaming rules (branch, bot, docs-only,
 * min-lines, duplicate SHA, daily cap, cooldown) apply identically
 * whether or not the repo has a vesting grant — counting is keyed by the
 * repo's standard repoId either way, so a repo that later gets a grant
 * keeps one continuous counter history.
 */
async function evaluateAndRecordPush(args: {
  repoId: string;
  repoFullName: string;
  payload: PushPayload;
  installationId?: number;
  platform: "github" | "gitlawb";
  bypassCooldown?: boolean;
  bypassDailyCap?: boolean;
}): Promise<EvaluatedPush> {
  const { repoId, payload } = args;

  // Ship PR-credit (§8): a merged PR is evaluated on the PR's own diff/author
  // and normalised to a single commit, so one merge counts at most once.
  // Non-PR pushes (and any PR-lookup failure) keep the legacy raw-push flow.
  let prCredit: MergedPrCredit | null = null;
  let effectivePayload = payload;
  let linesOverride: number | undefined;
  if (args.platform === "github") {
    prCredit = await resolveMergedPrCredit(args.repoFullName, payload, args.installationId);
    if (prCredit) {
      effectivePayload = prCredit.payload;
      linesOverride = prCredit.linesChanged;
    }
  }

  const verifyResult = await verifyPush(repoId, effectivePayload, {
    platform: args.platform,
    ...(args.bypassCooldown ? { bypassCooldown: true } : {}),
    ...(args.bypassDailyCap ? { bypassDailyCap: true } : {}),
    ...(linesOverride !== undefined ? { linesOverride } : {}),
  });

  if (!verifyResult.accepted) {
    await recordRejectedPush(repoId, effectivePayload, verifyResult);
    return { accepted: false, reason: verifyResult.reason };
  }

  const newPushCount = await recordVerifiedPush(repoId, effectivePayload, verifyResult);
  return {
    accepted: true,
    reason: verifyResult.reason,
    verifiedPushCount: newPushCount,
    prCredit,
  };
}

/**
 * Ship dual reward (§8B): every counted merged PR pays the flat per-merge
 * reward to the PR author's linked wallet — or accrues it as pending when
 * the author has none. ONE implementation shared by the grant path and
 * the grant-less path; safely no-ops when ShipRewards is not configured
 * or the configured amount is 0.
 */
async function rewardForCountedPush(args: {
  chain: string;
  repoId: string;
  repoFullName: string;
  prCredit: MergedPrCredit | null;
}): Promise<RewardResult | undefined> {
  if (!args.prCredit) return undefined;
  return payRewardForMerge({
    chain: args.chain,
    repoId: args.repoId,
    repoFullName: args.repoFullName,
    authorLogin: args.prCredit.authorLogin,
    mergeCommitSha: args.prCredit.mergeCommitSha,
  });
}

function prCreditSummary(prCredit: MergedPrCredit | null): Pick<PushProcessResult, "prCredit"> {
  return prCredit
    ? { prCredit: { prNumber: prCredit.prNumber, authorLogin: prCredit.authorLogin } }
    : {};
}

/** Shared push → verify → count → optional release flow (webhook + dev simulate). */
export async function processPushForGrant(
  grant: GrantRecord,
  payload: PushPayload,
  options?: { bypassCooldown?: boolean; bypassDailyCap?: boolean; platform?: "github" | "gitlawb" },
): Promise<PushProcessResult> {
  const repoId = grant.repoId;
  const platform = options?.platform ?? grant.platform ?? "github";

  const evaluated = await evaluateAndRecordPush({
    repoId,
    repoFullName: grant.repoFullName,
    payload,
    installationId: grant.installationId,
    platform,
    bypassCooldown: options?.bypassCooldown,
    bypassDailyCap: options?.bypassDailyCap,
  });

  if (!evaluated.accepted) {
    return { accepted: false, reason: evaluated.reason };
  }

  await updateGrant(repoId, { verifiedPushCount: evaluated.verifiedPushCount });
  const release = await triggerReleaseIfMilestone(repoId, grant, evaluated.verifiedPushCount);
  const reward = await rewardForCountedPush({
    chain: grant.chain,
    repoId,
    repoFullName: grant.repoFullName,
    prCredit: evaluated.prCredit,
  });

  return {
    accepted: true,
    reason: evaluated.reason,
    verifiedPushCount: evaluated.verifiedPushCount,
    release,
    ...prCreditSummary(evaluated.prCredit),
    ...(reward ? { reward } : {}),
  };
}

/**
 * Grant-less push flow (audit H1): the repo has the GitHub App installed
 * (it webhooks us) but NO active vesting grant. Pushes are still verified
 * and counted, and a counted merged PR earns its author the per-merge
 * reward — paid from the Base ShipRewards pool (Base is the reward chain
 * when no grant dictates one). There is no unlock: nothing is locked.
 */
export async function processPushGrantless(
  repoFullName: string,
  payload: PushPayload,
): Promise<PushProcessResult> {
  const repoId = repoIdFromFullName(repoFullName);

  // Index the repo as grant-less-active so the recent-pushes feed
  // (discovery.ts) can find its push log — the feed enumerates grants,
  // and this repo has none. Bookkeeping only; never fail processing on it.
  try {
    await getRedis().sadd(KEYS.grantlessRepos(), repoFullName);
  } catch (err) {
    console.warn("[processPush] grantless repo index failed (ignored):", err);
  }

  const evaluated = await evaluateAndRecordPush({
    repoId,
    repoFullName,
    payload,
    platform: "github",
  });

  if (!evaluated.accepted) {
    return { accepted: false, reason: evaluated.reason };
  }

  const reward = await rewardForCountedPush({
    chain: "base",
    repoId,
    repoFullName,
    prCredit: evaluated.prCredit,
  });

  return {
    accepted: true,
    reason: evaluated.reason,
    verifiedPushCount: evaluated.verifiedPushCount,
    ...prCreditSummary(evaluated.prCredit),
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
