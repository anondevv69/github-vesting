import type { GrantRecord } from "../lib/redis";
import { updateGrant, getRedis, KEYS } from "../lib/redis";
import {
  verifyPush,
  recordVerifiedPush,
  recordRejectedPush,
  type PushPayload,
  type SwarmLogInfo,
} from "./pushVerifier";
import { writePushCheckpoint } from "../lib/recount";
import { resolveMergedPrCredit, type MergedPrCredit } from "./prCredit";
import { triggerReleaseIfMilestone } from "../oracle/releaseOracle";
import { triggerFeeReleaseIfDue, type FeeReleaseResult } from "../oracle/feeLock";
import {
  payRewardForMerge,
  payReviewerRewardsForMerge,
  type RewardResult,
  type ReviewerRewardOutcome,
} from "../oracle/shipRewards";
import {
  evaluateSwarmGate,
  quorumReviewers,
  recordCountedFingerprint,
  type QuorumStatus,
} from "../lib/swarmReview";
import { repoIdFromFullName } from "../lib/repoId";

export type PushProcessResult = {
  accepted: boolean;
  reason: string;
  verifiedPushCount?: number;
  release?: Awaited<ReturnType<typeof triggerReleaseIfMilestone>>;
  /** Fee-lock tranche release (only for grants with a fee-lock vault). */
  feeRelease?: FeeReleaseResult;
  /** Set when the counted push was credited to a merged PR (Ship spec §8). */
  prCredit?: { prNumber: number; authorLogin: string };
  /** Per-merge Ship reward outcome (spec §8B) — only for PR-credited pushes. */
  reward?: RewardResult;
  /** Reviewer-swarm outcome — only for pushes on swarm-required grants. */
  swarm?: {
    quorum: QuorumStatus;
    reviewerRewards?: ReviewerRewardOutcome[];
  };
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
/** Head SHA of the effective (possibly PR-normalised) payload. */
function effectiveHeadSha(payload: PushPayload): string {
  if (payload.after) return payload.after.toLowerCase();
  const last = payload.commits[payload.commits.length - 1];
  return (last?.id ?? "").toLowerCase();
}

async function evaluateAndRecordPush(args: {
  repoId: string;
  repoFullName: string;
  payload: PushPayload;
  installationId?: number;
  platform: "github" | "gitlawb";
  bypassCooldown?: boolean;
  bypassDailyCap?: boolean;
  /**
   * Reviewer-swarm gate (opt-in per grant): consulted AFTER the
   * verifier accepts and BEFORE the push is recorded as counted.
   * Returning not-ok rejects the push with the swarm reason, logged
   * exactly like a verifier rejection. The gate can only block —
   * counting still happens here, on the webhook path, or nowhere.
   */
  swarmGate?: (ctx: {
    prCredit: MergedPrCredit | null;
    effectivePayload: PushPayload;
  }) => Promise<
    | { ok: true; swarm: SwarmLogInfo }
    | { ok: false; reason: string; swarm?: SwarmLogInfo }
  >;
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

  // Reviewer swarm: an additional gate between verifier acceptance and
  // counting. A not-ok verdict is recorded as a rejection (same push
  // log, same semantics as a verifier rejection) and the push is NOT
  // counted — no recordVerifiedPush, no seen-SHA mark, so a later
  // webhook (re)delivery re-evaluates once reviews arrive. The swarm
  // verdict is stamped onto whichever log entry this push produces,
  // counted or rejected, so the recount can replay swarm decisions
  // (Codex round-2).
  let swarmInfo: SwarmLogInfo | undefined;
  if (args.swarmGate) {
    const gate = await args.swarmGate({ prCredit, effectivePayload });
    swarmInfo = gate.swarm;
    if (!gate.ok) {
      await recordRejectedPush(
        repoId,
        effectivePayload,
        {
          accepted: false,
          reason: gate.reason,
          linesEstimate: verifyResult.linesEstimate,
        },
        swarmInfo ? { swarm: swarmInfo } : undefined,
      );
      return { accepted: false, reason: gate.reason };
    }
  }

  const claim = await recordVerifiedPush(repoId, effectivePayload, verifyResult, {
    ...(args.bypassCooldown ? { bypassCooldown: true } : {}),
    ...(args.bypassDailyCap ? { bypassDailyCap: true } : {}),
    ...(swarmInfo ? { swarm: swarmInfo } : {}),
  });
  if ("conflict" in claim) {
    // Lost the atomic claim. "duplicate": a concurrent delivery of
    // this same push already counted it. "daily-cap" / "cooldown"
    // (Codex round-2): a DIFFERENT push won the race for the last
    // cap slot / inside the cooldown window — the verifier's
    // pre-checks passed against state that changed before the claim.
    // All three are rejections (logged like any other) so no
    // release/reward path runs twice for one push.
    const reason =
      claim.conflict === "duplicate"
        ? "Duplicate push — already counted by a concurrent delivery"
        : claim.conflict === "daily-cap"
          ? "Daily cap reached by a concurrent push (atomic claim)"
          : "Cooldown window claimed by a concurrent push (atomic claim)";
    await recordRejectedPush(repoId, effectivePayload, {
      accepted: false,
      reason,
      linesEstimate: verifyResult.linesEstimate,
    });
    return { accepted: false, reason };
  }
  return {
    accepted: true,
    reason: verifyResult.reason,
    verifiedPushCount: claim.total,
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

/**
 * Persist the recount checkpoint after a counted push (Codex
 * round-2): the snapshot a future recount starts from when the push
 * log has been trimmed past this point. Bookkeeping only — a failed
 * checkpoint write never fails push processing (the recount then
 * falls back to genesis replay / refusal, never a wrong total).
 */
async function checkpointQuietly(repoId: string, repoFullName: string, total: number): Promise<void> {
  try {
    await writePushCheckpoint(repoId, repoFullName, total);
  } catch (err) {
    console.warn("[processPush] recount checkpoint write failed (ignored):", err);
  }
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
  const swarmRequired = grant.swarmReviewRequired === true;
  let swarmQuorum: QuorumStatus | undefined;

  const evaluated = await evaluateAndRecordPush({
    repoId,
    repoFullName: grant.repoFullName,
    payload,
    installationId: grant.installationId,
    platform,
    bypassCooldown: options?.bypassCooldown,
    bypassDailyCap: options?.bypassDailyCap,
    ...(swarmRequired
      ? {
          swarmGate: async ({ prCredit, effectivePayload }) => {
            const verdict = await evaluateSwarmGate({
              repo: grant.repoFullName,
              headSha: effectiveHeadSha(effectivePayload),
              authorLogin: prCredit?.authorLogin,
              fingerprint: prCredit?.fingerprint,
            });
            swarmQuorum = verdict.quorum;
            const swarm: SwarmLogInfo = {
              required: true,
              ...(prCredit?.fingerprint ? { fingerprint: prCredit.fingerprint } : {}),
              passCount: verdict.quorum.passCount,
              failCount: verdict.quorum.failCount,
              duplicateFlagged: verdict.quorum.duplicateFlagged,
              met: verdict.ok,
            };
            return verdict.ok
              ? { ok: true as const, swarm }
              : { ok: false as const, reason: verdict.reason, swarm };
          },
        }
      : {}),
  });

  if (!evaluated.accepted) {
    return {
      accepted: false,
      reason: evaluated.reason,
      ...(swarmRequired && swarmQuorum ? { swarm: { quorum: swarmQuorum } } : {}),
    };
  }

  await updateGrant(repoId, { verifiedPushCount: evaluated.verifiedPushCount });
  const release = await triggerReleaseIfMilestone(repoId, grant, evaluated.verifiedPushCount);
  // Fee-lock: the launcher's locked trading-fee tranches vest on the
  // same counted pushes, through the same oracle — independently of
  // supply milestones (their own pushesPerTranche schedule on-chain).
  const feeRelease = await triggerFeeReleaseIfDue(repoId, grant, evaluated.verifiedPushCount);
  const reward = await rewardForCountedPush({
    chain: grant.chain,
    repoId,
    repoFullName: grant.repoFullName,
    prCredit: evaluated.prCredit,
  });

  // Reviewer swarm, post-count (still the webhook path — reviews alone
  // never reach this code): record the counted diff's fingerprint in
  // the repo's uniqueness ledger, and pay each PASS reviewer in the
  // quorum from the same ShipRewards pool as the author's reward.
  let swarm: PushProcessResult["swarm"];
  if (swarmRequired) {
    const headSha = effectiveHeadSha(evaluated.prCredit?.payload ?? payload);
    const fingerprint = evaluated.prCredit?.fingerprint;
    if (fingerprint) {
      await recordCountedFingerprint(grant.repoFullName, headSha, fingerprint);
    }
    let reviewerRewards: ReviewerRewardOutcome[] | undefined;
    if (evaluated.prCredit) {
      const reviewers = await quorumReviewers(grant.repoFullName, headSha);
      // If the PR path gave no server fingerprint, the fingerprint the
      // quorum agreed on still enters the uniqueness ledger.
      if (!fingerprint && reviewers.length > 0) {
        await recordCountedFingerprint(
          grant.repoFullName,
          headSha,
          reviewers[0]!.fingerprint,
        );
      }
      reviewerRewards = await payReviewerRewardsForMerge({
        chain: grant.chain,
        repoId,
        repoFullName: grant.repoFullName,
        mergeCommitSha: evaluated.prCredit.mergeCommitSha,
        reviewers: reviewers.map((r) => ({ reviewerLogin: r.reviewerLogin })),
      });
    }
    swarm = {
      quorum: swarmQuorum ?? {
        required: 0,
        passCount: 0,
        failCount: 0,
        duplicateFlagged: false,
        met: true,
        blocked: false,
      },
      ...(reviewerRewards ? { reviewerRewards } : {}),
    };
  }

  // Checkpoint AFTER the counted fingerprint entered the registry, so
  // the snapshot's registry digest covers this push too.
  await checkpointQuietly(repoId, grant.repoFullName, evaluated.verifiedPushCount);

  return {
    accepted: true,
    reason: evaluated.reason,
    verifiedPushCount: evaluated.verifiedPushCount,
    release,
    feeRelease,
    ...prCreditSummary(evaluated.prCredit),
    ...(reward ? { reward } : {}),
    ...(swarm ? { swarm } : {}),
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

  await checkpointQuietly(repoId, repoFullName, evaluated.verifiedPushCount);

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
