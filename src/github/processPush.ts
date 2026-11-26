import type { GrantRecord } from "../lib/redis";
import { updateGrant, getRedis, getGrantByRepoFullName, KEYS } from "../lib/redis";
import {
  verifyPush,
  recordVerifiedPush,
  recordRejectedPush,
  type PushPayload,
  type SwarmLogInfo,
  type VerifyResult,
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
  evaluateSwarmWindow,
  loadPendingPush,
  savePendingPush,
  deletePendingPush,
  listPendingPushRefs,
  noteSwarmWindow,
  noteSwarmCounted,
  quorumReviewers,
  recordCountedFingerprint,
  type QuorumStatus,
  type SwarmCountPath,
  type SwarmPendingPush,
} from "../lib/swarmReview";
import { resolveShipReport, recordPushSettlement } from "../api/shipReport";
import { repoIdFromFullName } from "../lib/repoId";

export type PushProcessResult = {
  accepted: boolean;
  reason: string;
  /**
   * True when the push passed the verifier and is held inside its
   * mandatory swarm review window (not counted yet, not rejected):
   * it counts on quorum PASS or at window expiry (verifier fallback).
   */
  pending?: boolean;
  verifiedPushCount?: number;
  release?: Awaited<ReturnType<typeof triggerReleaseIfMilestone>>;
  /** Fee-lock tranche release (only for grants with a fee-lock vault). */
  feeRelease?: FeeReleaseResult;
  /** Set when the counted push was credited to a merged PR (Ship spec §8). */
  prCredit?: { prNumber: number; authorLogin: string };
  /** Per-merge Ship reward outcome (spec §8B) — only for PR-credited pushes. */
  reward?: RewardResult;
  /** Reviewer-swarm outcome — every grant push is swarm-gated. */
  swarm?: {
    quorum: QuorumStatus;
    /** How the push counted ("swarm" | "verifier-fallback"), when counted. */
    countPath?: SwarmCountPath;
    /** Review-window expiry (ms epoch), while the push is pending. */
    windowExpiresAt?: number;
    reviewerRewards?: ReviewerRewardOutcome[];
  };
};

type EvaluatedPush =
  | { accepted: false; reason: string }
  | {
      accepted: false;
      pending: true;
      reason: string;
      pendingPush: SwarmPendingPush;
      quorum: QuorumStatus;
    }
  | {
      accepted: true;
      reason: string;
      verifiedPushCount: number;
      prCredit: MergedPrCredit | null;
      /** Swarm path the push counted through (grant path only). */
      countPath?: SwarmCountPath;
      quorum?: QuorumStatus;
    };

/** The swarm gate's three outcomes for a verifier-accepted push. */
type SwarmGateOutcome =
  | { action: "count"; countPath: SwarmCountPath; swarm: SwarmLogInfo; quorum: QuorumStatus }
  | { action: "veto"; reason: string; swarm: SwarmLogInfo; quorum: QuorumStatus }
  | {
      action: "pending";
      reason: string;
      swarm: SwarmLogInfo;
      quorum: QuorumStatus;
      pendingPush: SwarmPendingPush;
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
   * Reviewer-swarm gate (mandatory for grants, 2026-11-26): consulted
   * AFTER the verifier accepts and BEFORE the push is recorded as
   * counted. "count" records the push now; "veto" records a rejection
   * with the swarm verdict stamped on, exactly like a verifier
   * rejection; "pending" records NOTHING — the push waits inside its
   * review window (the caller has stored the pending record) and
   * finalises when the gate later returns count/veto. The gate can
   * only block or delay — counting still happens here, on the
   * platform counting path, or nowhere.
   */
  swarmGate?: (ctx: {
    prCredit: MergedPrCredit | null;
    effectivePayload: PushPayload;
    verifyResult: Extract<VerifyResult, { accepted: true }>;
  }) => Promise<SwarmGateOutcome>;
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

  // Reviewer swarm: the mandatory gate between verifier acceptance
  // and counting. A "veto" verdict is recorded as a rejection (same
  // push log, same semantics as a verifier rejection). A "pending"
  // verdict records NOTHING — the push sits in its review window and
  // the stored pending record finalises it later, so the recount
  // never sees a half-state. The swarm verdict is stamped onto
  // whichever log entry a counted/vetoed push produces, so the
  // recount can replay swarm decisions (Codex round-2).
  let swarmInfo: SwarmLogInfo | undefined;
  let swarmCountPath: SwarmCountPath | undefined;
  let swarmQuorum: QuorumStatus | undefined;
  if (args.swarmGate) {
    const gate = await args.swarmGate({
      prCredit,
      effectivePayload,
      verifyResult: verifyResult as Extract<VerifyResult, { accepted: true }>,
    });
    swarmInfo = gate.swarm;
    swarmQuorum = gate.quorum;
    if (gate.action === "veto") {
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
    if (gate.action === "pending") {
      return {
        accepted: false,
        pending: true,
        reason: gate.reason,
        pendingPush: gate.pendingPush,
        quorum: gate.quorum,
      };
    }
    swarmCountPath = gate.countPath;
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
    ...(swarmCountPath ? { countPath: swarmCountPath } : {}),
    ...(swarmQuorum ? { quorum: swarmQuorum } : {}),
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

/**
 * Everything that happens once a push is COUNTED, shared by the
 * webhook path and the swarm settler: grant counter, milestone +
 * fee-tranche releases, author reward, the counted fingerprint in
 * the uniqueness ledger, reviewer rewards (swarm path only), the
 * candidate's count-path stamp, and the recount checkpoint.
 */
async function afterCountedPush(
  grant: GrantRecord,
  args: {
    /** The verifier's acceptance reason (what the push log records). */
    reason: string;
    verifiedPushCount: number;
    prCredit: MergedPrCredit | null;
    /** Payload whose head SHA identifies the push (PR-normalised when credited). */
    effectivePayload: PushPayload;
    countPath: SwarmCountPath;
    quorum?: QuorumStatus;
  },
): Promise<PushProcessResult> {
  const repoId = grant.repoId;
  const headSha = effectiveHeadSha(args.effectivePayload);
  const fingerprint = args.prCredit?.fingerprint;

  await updateGrant(repoId, { verifiedPushCount: args.verifiedPushCount });
  const release = await triggerReleaseIfMilestone(repoId, grant, args.verifiedPushCount);
  // Fee-lock: the launcher's locked trading-fee tranches vest on the
  // same counted pushes, through the same oracle — independently of
  // supply milestones (their own pushesPerTranche schedule on-chain).
  const feeRelease = await triggerFeeReleaseIfDue(repoId, grant, args.verifiedPushCount);
  const reward = await rewardForCountedPush({
    chain: grant.chain,
    repoId,
    repoFullName: grant.repoFullName,
    prCredit: args.prCredit,
  });

  // Reviewer swarm, post-count (still the platform counting path —
  // reviews alone never reach this code): record the counted diff's
  // fingerprint in the repo's uniqueness ledger, stamp how the push
  // counted onto its candidate record, and — ONLY when the push
  // counted through the swarm — pay each PASS reviewer in the quorum
  // from the same ShipRewards pool as the author's reward. A push
  // that counted via the verifier fallback pays no reviewer rewards.
  if (fingerprint) {
    await recordCountedFingerprint(grant.repoFullName, headSha, fingerprint);
  }
  let reviewerRewards: ReviewerRewardOutcome[] | undefined;
  if (args.countPath === "swarm" && args.prCredit) {
    const reviewers = await quorumReviewers(grant.repoFullName, headSha);
    // If the PR path gave no server fingerprint, the fingerprint the
    // quorum agreed on still enters the uniqueness ledger.
    if (!fingerprint && reviewers.length > 0) {
      await recordCountedFingerprint(grant.repoFullName, headSha, reviewers[0]!.fingerprint);
    }
    reviewerRewards = await payReviewerRewardsForMerge({
      chain: grant.chain,
      repoId,
      repoFullName: grant.repoFullName,
      mergeCommitSha: args.prCredit.mergeCommitSha,
      reviewers: reviewers.map((r) => ({ reviewerLogin: r.reviewerLogin })),
    });
  }
  await noteSwarmCounted(grant.repoFullName, headSha, args.countPath);

  // Checkpoint AFTER the counted fingerprint entered the registry, so
  // the snapshot's registry digest covers this push too.
  await checkpointQuietly(repoId, grant.repoFullName, args.verifiedPushCount);

  return {
    accepted: true,
    reason: args.reason,
    verifiedPushCount: args.verifiedPushCount,
    release,
    feeRelease,
    ...prCreditSummary(args.prCredit),
    ...(reward ? { reward } : {}),
    swarm: {
      quorum: args.quorum ?? {
        required: 0,
        passCount: 0,
        failCount: 0,
        duplicateFlagged: false,
        met: true,
        blocked: false,
      },
      countPath: args.countPath,
      ...(reviewerRewards ? { reviewerRewards } : {}),
    },
  };
}

/** Build the push-log swarm stamp for a gate verdict on a grant push. */
function swarmLogInfo(args: {
  fingerprint?: string;
  quorum: QuorumStatus;
  met: boolean;
  countPath?: SwarmCountPath;
  windowOpenedAt?: number;
  windowExpiresAt?: number;
}): SwarmLogInfo {
  return {
    required: true,
    ...(args.fingerprint ? { fingerprint: args.fingerprint } : {}),
    passCount: args.quorum.passCount,
    failCount: args.quorum.failCount,
    duplicateFlagged: args.quorum.duplicateFlagged,
    met: args.met,
    ...(args.countPath ? { countPath: args.countPath } : {}),
    ...(args.windowOpenedAt !== undefined ? { windowOpenedAt: args.windowOpenedAt } : {}),
    ...(args.windowExpiresAt !== undefined ? { windowExpiresAt: args.windowExpiresAt } : {}),
  };
}

/**
 * Re-evaluate ONE pending (in-window) push against the current gate
 * state and finalise it when the gate resolves: count it (quorum or
 * expired window), veto it (FAIL / duplicate), or leave it pending.
 * Invoked from webhook redeliveries, review submissions, and the
 * platform settler — all three run this same counting code, and the
 * atomic claim in recordVerifiedPush arbitrates any race between
 * them, so a push can never count (or pay) twice.
 */
export async function resolvePendingPush(
  grant: GrantRecord,
  pending: SwarmPendingPush,
): Promise<PushProcessResult> {
  const repoId = grant.repoId;
  const headSha = pending.headSha;
  const payload = pending.payload;
  const prCredit: MergedPrCredit | null = pending.prCredit
    ? ({ ...pending.prCredit, payload } as unknown as MergedPrCredit)
    : null;

  const verdict = await evaluateSwarmWindow({
    repo: grant.repoFullName,
    headSha,
    authorLogin: prCredit?.authorLogin,
    fingerprint: prCredit?.fingerprint,
    pending,
  });

  if (verdict.state === "pending") {
    return {
      accepted: false,
      pending: true,
      reason: verdict.reason,
      swarm: { quorum: verdict.quorum, windowExpiresAt: verdict.windowExpiresAt },
    };
  }

  if (verdict.state === "veto") {
    await recordRejectedPush(
      repoId,
      payload,
      { accepted: false, reason: verdict.reason, linesEstimate: pending.linesEstimate },
      {
        swarm: swarmLogInfo({
          fingerprint: prCredit?.fingerprint,
          quorum: verdict.quorum,
          met: false,
        }),
      },
    );
    await deletePendingPush(grant.repoFullName, headSha);
    // Attestation layer bookkeeping, mirroring the webhook path.
    await resolveShipReport(grant.repoFullName, headSha, {
      kind: "rejected",
      reason: verdict.reason,
    });
    return {
      accepted: false,
      reason: verdict.reason,
      swarm: { quorum: verdict.quorum },
    };
  }

  // verdict.state === "count": record through the same atomic claim
  // the webhook path uses, stamping the path the push counted by.
  const claim = await recordVerifiedPush(
    repoId,
    payload,
    { accepted: true, reason: pending.verifyReason, linesEstimate: pending.linesEstimate },
    {
      ...(pending.bypassCooldown ? { bypassCooldown: true } : {}),
      ...(pending.bypassDailyCap ? { bypassDailyCap: true } : {}),
      swarm: swarmLogInfo({
        fingerprint: prCredit?.fingerprint,
        quorum: verdict.quorum,
        met: true,
        countPath: verdict.countPath,
        windowOpenedAt: verdict.windowOpenedAt,
        windowExpiresAt: verdict.windowExpiresAt,
      }),
    },
  );
  await deletePendingPush(grant.repoFullName, headSha);
  if ("conflict" in claim) {
    if (claim.conflict === "duplicate") {
      // A concurrent evaluation already counted this push and ran the
      // settlement tail there. Nothing more to do — and nothing to
      // log: the counted entry already exists.
      return {
        accepted: false,
        reason: "Duplicate push — already counted by a concurrent settlement",
        swarm: { quorum: verdict.quorum, countPath: verdict.countPath },
      };
    }
    // A different push won the last daily-cap slot / the cooldown
    // window while this push waited out its review window. The claim
    // is the authoritative guard, so the push does not count; the
    // rejection is logged like any other (the recount replays the
    // cap/cooldown rules from the record, as with webhook races).
    const reason =
      claim.conflict === "daily-cap"
        ? "Daily cap reached by a concurrent push (atomic claim at swarm settlement)"
        : "Cooldown window claimed by a concurrent push (atomic claim at swarm settlement)";
    await recordRejectedPush(
      repoId,
      payload,
      { accepted: false, reason, linesEstimate: pending.linesEstimate },
      {
        swarm: swarmLogInfo({
          fingerprint: prCredit?.fingerprint,
          quorum: verdict.quorum,
          met: true,
          countPath: verdict.countPath,
          windowOpenedAt: verdict.windowOpenedAt,
          windowExpiresAt: verdict.windowExpiresAt,
        }),
      },
    );
    return { accepted: false, reason, swarm: { quorum: verdict.quorum } };
  }

  const counted = await afterCountedPush(grant, {
    reason: pending.verifyReason,
    verifiedPushCount: claim.total,
    prCredit,
    effectivePayload: payload,
    countPath: verdict.countPath,
    quorum: verdict.quorum,
  });

  // Attestation layer bookkeeping, mirroring the webhook path: the
  // push counted HERE (settler / review trigger / redelivery), so the
  // settlement evidence and the report resolution are recorded here.
  const releaseTxHash =
    counted.release && counted.release.triggered ? counted.release.txHash : undefined;
  const reward = counted.reward;
  if (releaseTxHash || reward?.paid) {
    await recordPushSettlement(grant.repoFullName, headSha, {
      ...(releaseTxHash ? { releaseTxHash } : {}),
      ...(counted.release && counted.release.triggered && counted.release.milestone !== undefined
        ? { milestone: counted.release.milestone }
        : {}),
      ...(reward?.paid
        ? {
            rewardTxHash: reward.txHash,
            rewardRecipient: reward.recipient,
            rewardAmount: reward.amount,
          }
        : {}),
    });
  }
  await resolveShipReport(grant.repoFullName, headSha, {
    kind: "counted",
    reason: counted.reason,
    ...(counted.verifiedPushCount !== undefined
      ? { verifiedPushCount: counted.verifiedPushCount }
      : {}),
    ...(releaseTxHash ? { releaseTxHash } : {}),
    ...(counted.release && counted.release.triggered && counted.release.milestone !== undefined
      ? { milestone: counted.release.milestone }
      : {}),
    ...(reward?.paid
      ? {
          rewardTxHash: reward.txHash,
          rewardRecipient: reward.recipient,
          rewardAmount: reward.amount,
        }
      : {}),
  });

  return counted;
}

/**
 * Best-effort settlement attempt for one push (review submissions and
 * other triggers): resolves the push iff it is pending on an active
 * grant. Returns null when there is nothing to settle.
 */
export async function trySettlePendingPush(
  repoFullName: string,
  headSha: string,
): Promise<PushProcessResult | null> {
  const pending = await loadPendingPush(repoFullName, headSha);
  if (!pending) return null;
  const grant = await getGrantByRepoFullName(repoFullName);
  if (!grant || grant.status !== "active") return null;
  return resolvePendingPush(grant, pending);
}

/**
 * The platform settler sweep: finalise every pending swarm push whose
 * gate has resolved (quorum met, FAIL veto, or window expired). Runs
 * on an interval from the server bootstrap; a failed push is logged
 * and left pending for the next sweep — the sweep never forces a
 * count the gate did not return.
 */
export async function settlePendingSwarmPushes(): Promise<{
  settled: number;
  vetoed: number;
  stillPending: number;
}> {
  const refs = await listPendingPushRefs();
  let settled = 0;
  let vetoed = 0;
  let stillPending = 0;
  for (const ref of refs) {
    try {
      const pending = await loadPendingPush(ref.repo, ref.headSha);
      if (!pending) {
        // Stale index member (record expired): prune it.
        await deletePendingPush(ref.repo, ref.headSha);
        continue;
      }
      const grant = await getGrantByRepoFullName(pending.repo);
      if (!grant || grant.status !== "active") continue;
      const result = await resolvePendingPush(grant, pending);
      if (result.accepted) settled++;
      else if (result.pending) stillPending++;
      else vetoed++;
    } catch (err) {
      console.warn(
        `[swarmSettler] could not resolve pending push ${ref.repo}@${ref.headSha.slice(0, 7)} — left pending:`,
        err,
      );
    }
  }
  return { settled, vetoed, stillPending };
}

/** Shared push → verify → count → optional release flow (webhook + dev simulate). */
export async function processPushForGrant(
  grant: GrantRecord,
  payload: PushPayload,
  options?: { bypassCooldown?: boolean; bypassDailyCap?: boolean; platform?: "github" | "gitlawb" },
): Promise<PushProcessResult> {
  const repoId = grant.repoId;
  const platform = options?.platform ?? grant.platform ?? "github";

  // A push already inside its review window re-evaluates ONLY the
  // swarm gate: the verifier passed when the window opened, and
  // re-running it now could spuriously reject (the daily cap or
  // cooldown moved in the meantime) a push that is legitimately
  // pending. Redelivery is one of the gate's settlement triggers.
  const rawHeadSha = effectiveHeadSha(payload);
  if (rawHeadSha) {
    const pending = await loadPendingPush(grant.repoFullName, rawHeadSha);
    if (pending) return resolvePendingPush(grant, pending);
  }

  let swarmQuorum: QuorumStatus | undefined;

  const evaluated = await evaluateAndRecordPush({
    repoId,
    repoFullName: grant.repoFullName,
    payload,
    installationId: grant.installationId,
    platform,
    bypassCooldown: options?.bypassCooldown,
    bypassDailyCap: options?.bypassDailyCap,
    // Swarm review is MANDATORY for every grant (Gregory, 2026-11-26):
    // there is no launcher opt-in/opt-out. The gate runs after the
    // verifier and before counting, on every grant push.
    swarmGate: async ({ prCredit, effectivePayload, verifyResult }) => {
      const headSha = effectiveHeadSha(effectivePayload);
      const verdict = await evaluateSwarmWindow({
        repo: grant.repoFullName,
        headSha,
        authorLogin: prCredit?.authorLogin,
        fingerprint: prCredit?.fingerprint,
      });
      swarmQuorum = verdict.quorum;
      if (verdict.state === "veto") {
        return {
          action: "veto" as const,
          reason: verdict.reason,
          quorum: verdict.quorum,
          swarm: swarmLogInfo({
            fingerprint: prCredit?.fingerprint,
            quorum: verdict.quorum,
            met: false,
          }),
        };
      }
      if (verdict.state === "count") {
        return {
          action: "count" as const,
          countPath: verdict.countPath,
          quorum: verdict.quorum,
          swarm: swarmLogInfo({
            fingerprint: prCredit?.fingerprint,
            quorum: verdict.quorum,
            met: true,
            countPath: verdict.countPath,
            windowOpenedAt: verdict.windowOpenedAt,
            windowExpiresAt: verdict.windowExpiresAt,
          }),
        };
      }
      // Pending: the review window opens at THIS verifier pass. Store
      // everything settlement needs so the push can finalise without
      // a webhook redelivery (settler / review-triggered resolution).
      const pendingPush: SwarmPendingPush = {
        repo: grant.repoFullName,
        repoId,
        headSha,
        payload: effectivePayload,
        prCredit: prCredit
          ? (({ payload: _payload, ...rest }) => rest)(prCredit)
          : null,
        verifyReason: verifyResult.reason,
        linesEstimate: verifyResult.linesEstimate,
        platform,
        ...(options?.bypassCooldown ? { bypassCooldown: true } : {}),
        ...(options?.bypassDailyCap ? { bypassDailyCap: true } : {}),
        windowOpenedAt: verdict.windowOpenedAt,
        windowExpiresAt: verdict.windowExpiresAt,
        storedAt: new Date().toISOString(),
      };
      await savePendingPush(pendingPush);
      await noteSwarmWindow(
        grant.repoFullName,
        headSha,
        verdict.windowOpenedAt,
        verdict.windowExpiresAt,
      );
      return {
        action: "pending" as const,
        reason: verdict.reason,
        quorum: verdict.quorum,
        pendingPush,
        swarm: swarmLogInfo({
          fingerprint: prCredit?.fingerprint,
          quorum: verdict.quorum,
          met: false,
          windowOpenedAt: verdict.windowOpenedAt,
          windowExpiresAt: verdict.windowExpiresAt,
        }),
      };
    },
  });

  if (!evaluated.accepted) {
    if ("pending" in evaluated && evaluated.pending) {
      return {
        accepted: false,
        pending: true,
        reason: evaluated.reason,
        swarm: {
          quorum: evaluated.quorum,
          windowExpiresAt: evaluated.pendingPush.windowExpiresAt,
        },
      };
    }
    return {
      accepted: false,
      reason: evaluated.reason,
      ...(swarmQuorum ? { swarm: { quorum: swarmQuorum } } : {}),
    };
  }

  return afterCountedPush(grant, {
    reason: evaluated.reason,
    verifiedPushCount: evaluated.verifiedPushCount,
    prCredit: evaluated.prCredit,
    effectivePayload: evaluated.prCredit?.payload ?? payload,
    // The inline path can only count through the swarm (a fallback
    // count requires a stored window, which resolvePendingPush owns);
    // evaluateAndRecordPush reports the gate's path explicitly.
    countPath: evaluated.countPath ?? "swarm",
    quorum: evaluated.quorum ?? swarmQuorum,
  });
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
