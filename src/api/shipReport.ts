/**
 * Ship reports — the Claude attestation layer (signal/UX only).
 *
 * POST /api/agent/report-ship              { repo, headSha, prNumber?, authorLogin? }
 * GET  /api/agent/ship-report?repo=&sha=   current state of one report
 * GET  /api/agent/ship-reports?repo=       recent reports for a repo (newest first, cap 20)
 *
 * TRUST MODEL — read before touching this file:
 * A ship report is a *claim* by a developer-side Claude (via the skill, the
 * MCP server, or the Claude Code push hook) that "I just shipped this
 * commit". It is unauthenticated BY DESIGN: a report is worthless to fake,
 * because a report NEVER moves money and NEVER influences the verifier.
 * Settlement is unchanged and remains exactly one path:
 *
 *     GitHub push webhook → pushVerifier → oracle (release + reward)
 *
 * The webhook handler calls `resolveShipReport()` once the real outcome for
 * a push is known, which transitions a matching report. A report filed
 * AFTER its push was already processed reconciles at creation time from
 * the verifier's recorded push log (see reconcileFromRecordedOutcome):
 *
 *     reported ──counted, no payout──▶ confirmed
 *              ──counted + release and/or reward tx──▶ paid
 *              ──rejected (docs-only / bot / cap / cooldown)──▶ rejected
 *              ──no webhook within 24h──▶ expired (evaluated lazily on read)
 *
 * Grant-less repos (no active vesting grant — audit H1): pushes are still
 * verified, and reports resolve to `paid` when the counted merge's reward
 * actually pays (immediately, or later when an accrued pending reward
 * settles on wallet link) and to `rejected` with the verifier's reason.
 * There is no grant progress to "confirm", so a counted grant-less push
 * whose reward accrued/unconfigured leaves the report `reported` until it
 * expires or settlement flips it to `paid`.
 *
 * The record carries `settlement: "github-webhook"` and
 * `reportMovesMoney: false` in every API response so no client can mistake
 * a report for a payment.
 */

import type { Request, Response } from "express";
import { getRedis, KEYS, getGrantByRepoFullName } from "../lib/redis";
import { repoIdFromFullName } from "../lib/repoId";

/** Reports (and the per-repo report index) live for 48h. */
const REPORT_TTL_SECONDS = 48 * 60 * 60;
/** A report still unconfirmed 24h after it was filed reads as expired. */
const EXPIRY_MS = 24 * 60 * 60 * 1000;
const MAX_REPORTS_PER_REPO = 20;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-fA-F]{40}$/;
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

export type ShipReportStoredState = "reported" | "confirmed" | "paid" | "rejected";
export type ShipReportState = ShipReportStoredState | "expired";

export type ShipReportRecord = {
  repo: string;
  headSha: string;
  prNumber?: number;
  authorLogin?: string;
  state: ShipReportStoredState;
  reportedAt: string;
  updatedAt: string;
  /** Set on counted outcomes. */
  verifiedPushCount?: number;
  /** Set when the counted push produced a vesting release and/or a merge reward. */
  releaseTxHash?: string;
  milestone?: number;
  rewardTxHash?: string;
  rewardRecipient?: string;
  rewardAmount?: string;
  /** Verifier reason for rejections; accept reason for counted pushes. */
  reason?: string;
};

export type ShipReportView = Omit<ShipReportRecord, "state"> & {
  state: ShipReportState;
  /** Settlement always happens via the GitHub webhook — never via a report. */
  settlement: "github-webhook";
  /** A report alone never releases tokens. */
  reportMovesMoney: false;
};

// ─── Storage ─────────────────────────────────────────────────────────────────

async function saveRecord(record: ShipReportRecord): Promise<void> {
  const redis = getRedis();
  await redis.set(
    KEYS.shipReport(record.repo, record.headSha),
    JSON.stringify(record),
    "EX",
    REPORT_TTL_SECONDS,
  );
}

async function loadRecord(repo: string, headSha: string): Promise<ShipReportRecord | null> {
  const raw = await getRedis().get(KEYS.shipReport(repo, headSha));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ShipReportRecord;
  } catch {
    return null;
  }
}

/** Present a stored record with lazy expiry + the trust-model fields. */
export function presentShipReport(record: ShipReportRecord): ShipReportView {
  const expired =
    record.state === "reported" &&
    Date.now() - new Date(record.reportedAt).getTime() > EXPIRY_MS;
  return {
    ...record,
    state: expired ? "expired" : record.state,
    settlement: "github-webhook",
    reportMovesMoney: false,
  };
}

// ─── Webhook-side resolution ─────────────────────────────────────────────────

export type ShipReportOutcome =
  | {
      kind: "counted";
      reason: string;
      verifiedPushCount?: number;
      releaseTxHash?: string;
      milestone?: number;
      rewardTxHash?: string;
      rewardRecipient?: string;
      rewardAmount?: string;
    }
  | { kind: "rejected"; reason: string };

/**
 * Transition the ship report matching (repo, headSha) to the webhook's real
 * outcome. Called from the GitHub webhook handler only.
 *
 * NEVER throws: a failure here must not affect webhook processing, counting,
 * or payouts. It also never creates a record — a push nobody reported has
 * nothing to resolve — and never downgrades a terminal `paid` record.
 */
export async function resolveShipReport(
  repoFullName: string,
  headSha: string | null | undefined,
  outcome: ShipReportOutcome,
): Promise<void> {
  try {
    if (!headSha || !SHA_RE.test(headSha)) return;
    const record = await loadRecord(repoFullName, headSha);
    if (!record) return;
    if (record.state === "paid") return; // terminal — strongest state wins

    if (outcome.kind === "rejected") {
      // Don't downgrade a confirmed push on a duplicate/redelivered webhook.
      if (record.state !== "reported") return;
      record.state = "rejected";
      record.reason = outcome.reason;
    } else {
      const paid = Boolean(outcome.releaseTxHash || outcome.rewardTxHash);
      record.state = paid ? "paid" : "confirmed";
      record.reason = outcome.reason;
      if (outcome.verifiedPushCount !== undefined) {
        record.verifiedPushCount = outcome.verifiedPushCount;
      }
      if (outcome.releaseTxHash) record.releaseTxHash = outcome.releaseTxHash;
      if (outcome.milestone !== undefined) record.milestone = outcome.milestone;
      if (outcome.rewardTxHash) record.rewardTxHash = outcome.rewardTxHash;
      if (outcome.rewardRecipient) record.rewardRecipient = outcome.rewardRecipient;
      if (outcome.rewardAmount) record.rewardAmount = outcome.rewardAmount;
    }
    record.updatedAt = new Date().toISOString();
    await saveRecord(record);
    console.log(
      `[ship-report] ${record.repo}@${record.headSha.slice(0, 8)} → ${record.state} (${outcome.kind})`,
    );
  } catch (err) {
    // Signal layer only — log and move on; settlement is unaffected.
    console.warn("[ship-report] resolve failed (ignored):", err);
  }
}

// ─── Late-report reconciliation ──────────────────────────────────────────────

type PushLogEntry = {
  sha?: string;
  accepted?: boolean;
  reason?: string;
};

/**
 * Reconcile a just-filed report against the outcome the webhook already
 * recorded for the same push (bug found live 2026-11-24: reports filed
 * AFTER their push sat in "reported" until expiry, because
 * resolveShipReport only ran at webhook time).
 *
 * The recorded-outcome store is the verifier's per-repo push log
 * (KEYS.pushLog): every processed push appends { sha, accepted, reason }.
 * That is enough to reconstruct:
 *   - rejected pushes → `rejected` with the verifier's exact reason;
 *   - counted pushes on a grant-backed repo → `confirmed`, with the
 *     verified push count derived exactly (the repo's authoritative
 *     pushCount total minus the accepted log entries after this one —
 *     entries after it are by definition still in the retained log).
 *
 * What the log does NOT record is per-push release/reward tx hashes, so
 * a late report can never be reconstructed to `paid` from it — claiming
 * `paid` without a tx hash would fabricate settlement evidence. Two
 * cases therefore deliberately stay `reported`:
 *   - Counted pushes on a grant-LESS repo: grant-less reports never take
 *     `confirmed` (there is no grant progress to confirm), and `paid`
 *     needs the reward tx hash. If the reward accrued as pending, the
 *     settlement path on wallet link calls resolveShipReport with the
 *     real tx and flips this record to `paid` then; if it paid
 *     immediately, the record stays until the 24h expiry — a known,
 *     documented limitation of the recorded data.
 *   - Pushes with no log entry at all (e.g. repo-claim verification
 *     pushes, which return before the verifier logs anything).
 *
 * NEVER throws and NEVER moves money: it only replays, through
 * resolveShipReport, an outcome the webhook path already produced.
 */
async function reconcileFromRecordedOutcome(record: ShipReportRecord): Promise<void> {
  try {
    const grant = await getGrantByRepoFullName(record.repo);
    const repoId = grant?.repoId ?? repoIdFromFullName(record.repo);
    const redis = getRedis();
    const rawEntries = await redis.lrange(KEYS.pushLog(repoId), 0, -1);
    const entries: PushLogEntry[] = [];
    for (const raw of rawEntries) {
      try {
        entries.push(JSON.parse(raw) as PushLogEntry);
      } catch { /* skip malformed */ }
    }

    const sha = record.headSha.toLowerCase();
    // An accepted entry for this SHA is the push's real outcome; rejected
    // entries with the same SHA are duplicate/redelivery noise (the
    // verifier rejects re-deliveries of an already-counted SHA), so an
    // accepted entry wins over any rejected one.
    let acceptedIdx = -1;
    let rejectedIdx = -1;
    entries.forEach((entry, i) => {
      if (entry.sha?.toLowerCase() !== sha) return;
      if (entry.accepted === false) rejectedIdx = i;
      else acceptedIdx = i;
    });

    if (acceptedIdx === -1) {
      if (rejectedIdx !== -1) {
        await resolveShipReport(record.repo, record.headSha, {
          kind: "rejected",
          reason: entries[rejectedIdx]!.reason ?? "Push rejected by verifier",
        });
      }
      return;
    }

    // Counted — but grant-less reports cannot take "confirmed" and cannot
    // be reconstructed to "paid" (see header comment). Leave "reported".
    if (!grant) return;

    const entry = entries[acceptedIdx]!;
    let verifiedPushCount: number | undefined;
    const totalRaw = await redis.get(KEYS.pushCount(repoId));
    const total = totalRaw ? parseInt(totalRaw, 10) : NaN;
    if (Number.isFinite(total)) {
      const acceptedAfter = entries
        .slice(acceptedIdx + 1)
        .filter((e) => e.accepted !== false).length;
      verifiedPushCount = total - acceptedAfter;
    }

    await resolveShipReport(record.repo, record.headSha, {
      kind: "counted",
      reason: entry.reason ?? "Push counted by verifier",
      ...(verifiedPushCount !== undefined ? { verifiedPushCount } : {}),
    });
  } catch (err) {
    // Signal layer only — a reconciliation failure must not fail the
    // report POST; the record simply stays "reported".
    console.warn("[ship-report] reconcile failed (ignored):", err);
  }
}

// ─── HTTP handlers ───────────────────────────────────────────────────────────

export async function handleReportShip(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const headShaRaw = typeof body.headSha === "string" ? body.headSha.trim() : "";
  const prNumber = body.prNumber;
  const authorLogin = body.authorLogin;

  if (!REPO_RE.test(repo)) {
    res.status(400).json({ ok: false, error: "repo required, shaped \"owner/repo\"" });
    return;
  }
  if (!SHA_RE.test(headShaRaw)) {
    res.status(400).json({ ok: false, error: "headSha required, 40-char hex commit SHA" });
    return;
  }
  if (
    prNumber !== undefined &&
    (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0)
  ) {
    res.status(400).json({ ok: false, error: "prNumber must be a positive integer" });
    return;
  }
  if (
    authorLogin !== undefined &&
    (typeof authorLogin !== "string" || !LOGIN_RE.test(authorLogin.trim()))
  ) {
    res.status(400).json({ ok: false, error: "authorLogin must be a GitHub login" });
    return;
  }

  const headSha = headShaRaw.toLowerCase();

  try {
    // Idempotent: re-reporting the same ship returns the existing record
    // untouched — a late duplicate report must not rewind a confirmed/paid
    // record back to "reported". A record still sitting in "reported"
    // first gets a chance to reconcile against the recorded push outcome
    // (which can only move it forward, via resolveShipReport's guards).
    const existing = await loadRecord(repo, headSha);
    if (existing) {
      if (existing.state === "reported") {
        await reconcileFromRecordedOutcome(existing);
        const refreshed = await loadRecord(repo, headSha);
        res.json({
          ok: true,
          alreadyReported: true,
          report: presentShipReport(refreshed ?? existing),
        });
        return;
      }
      res.json({ ok: true, alreadyReported: true, report: presentShipReport(existing) });
      return;
    }

    const now = new Date().toISOString();
    const record: ShipReportRecord = {
      repo,
      headSha,
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(authorLogin !== undefined ? { authorLogin: (authorLogin as string).trim() } : {}),
      state: "reported",
      reportedAt: now,
      updatedAt: now,
    };
    await saveRecord(record);

    // Per-repo recent-reports index (refs only; records stay the source of truth).
    const redis = getRedis();
    const listKey = KEYS.shipReportsByRepo(repo);
    await redis.lpush(listKey, headSha);
    await redis.ltrim(listKey, 0, MAX_REPORTS_PER_REPO - 1);
    await redis.expire(listKey, REPORT_TTL_SECONDS);

    // The push may already have been processed (report filed after the
    // fact — e.g. a Claude Code session reporting a merge it made
    // earlier). Resolve immediately from the recorded outcome instead
    // of leaving the report to expire.
    await reconcileFromRecordedOutcome(record);
    const refreshed = await loadRecord(repo, headSha);
    res.json({ ok: true, report: presentShipReport(refreshed ?? record) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: "Failed to store ship report", message: msg });
  }
}

export async function handleGetShipReport(req: Request, res: Response): Promise<void> {
  const repo = String(req.query["repo"] ?? "").trim();
  const sha = String(req.query["sha"] ?? req.query["headSha"] ?? "").trim();

  if (!REPO_RE.test(repo)) {
    res.status(400).json({ ok: false, error: "repo query param required (owner/repo)" });
    return;
  }
  if (!SHA_RE.test(sha)) {
    res.status(400).json({ ok: false, error: "sha query param required (40-char hex)" });
    return;
  }

  const record = await loadRecord(repo, sha);
  if (!record) {
    res.status(404).json({ ok: false, error: "No ship report found for this repo + sha" });
    return;
  }
  res.json({ ok: true, report: presentShipReport(record) });
}

export async function handleListShipReports(req: Request, res: Response): Promise<void> {
  const repo = String(req.query["repo"] ?? "").trim();
  if (!REPO_RE.test(repo)) {
    res.status(400).json({ ok: false, error: "repo query param required (owner/repo)" });
    return;
  }

  const redis = getRedis();
  const refs = await redis.lrange(KEYS.shipReportsByRepo(repo), 0, MAX_REPORTS_PER_REPO - 1);
  const seen = new Set<string>();
  const reports: ShipReportView[] = [];
  for (const sha of refs) {
    if (seen.has(sha)) continue;
    seen.add(sha);
    const record = await loadRecord(repo, sha);
    if (record) reports.push(presentShipReport(record));
  }
  // Index is LPUSH-ordered (newest first); records keep that order.
  res.json({ ok: true, repo, count: reports.length, reports });
}
