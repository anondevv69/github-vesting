/**
 * Reviewer swarm (Gregory, 2026-11-25): other people's agents act as
 * independent verifiers of pushes. A reviewer agent checks that a push's
 * code is genuinely different/new, meaningful, and passing, attests
 * pass/fail, and — when the push counts — is rewarded in the platform
 * reward token from the same ShipRewards pool as author rewards.
 *
 * DESIGN LAW — read before touching this file (same law as the
 * attestation layer in api/shipReport.ts):
 * Reviewer attestations are an ADDITIONAL GATE, never a settlement
 * trigger. Money still moves only via:
 *
 *     GitHub push webhook → pushVerifier → oracle (release + reward)
 *
 * A reviewer quorum can BLOCK a push from counting (this module is
 * consulted as a pre-condition inside the webhook's counting path, and
 * only there). It can NEVER force a release or a reward by itself: a
 * review submission moves no money, pays nobody, and counts nothing.
 * Reviewer rewards are paid by the oracle on the webhook path, after
 * the push has counted through the verifier, exactly like author
 * rewards — never at review time.
 *
 * Independence (hard rule): a reviewer must NOT be the push author,
 * the author's linked wallet, or the repo's launcher/claim wallet.
 * Self-review and same-wallet review are refused at submission time
 * with SWARM_REVIEW_NOT_INDEPENDENT.
 *
 * Uniqueness is a first-class duty: every reviewed push carries a diff
 * fingerprint (see computeDiffFingerprint). The server stores the
 * fingerprint of every COUNTED diff per repo; a new push whose
 * fingerprint exactly matches a previously counted diff is auto-flagged
 * as a duplicate and can never count. Reviewers submit their own
 * independently computed fingerprint with each review; a PASS review
 * whose fingerprint does not match the server's fingerprint for that
 * push does not count toward quorum (the reviewer reviewed different
 * code than the server saw).
 *
 * Quorum rule (as implemented):
 *   - Applies only to grants with `swarmReviewRequired: true`
 *     (opt-in per grant; default OFF — existing grants are unaffected).
 *   - A push counts only if at least SWARM_QUORUM (default 2)
 *     independent, enrolled reviewers have submitted effective PASS
 *     reviews for (repo, headSha), AND no independent enrolled reviewer
 *     has submitted an effective FAIL. A FAIL is a veto: it blocks the
 *     push outright (the author must push new code), which is also why
 *     a duplicate-flagged push can never reach a PASS quorum.
 *   - An effective PASS requires verdict "pass" AND different=true AND
 *     meaningful=true AND checksPass=true. Anything else is a FAIL.
 *   - If quorum is not met when the webhook evaluates the push, the
 *     push is NOT counted and the rejection is logged with the swarm
 *     reason, exactly like a verifier rejection. Reviews stay on file;
 *     a webhook (re)delivery after quorum is reached evaluates again —
 *     settlement still happens only on that webhook path.
 */

import { createHash } from "crypto";
import { getRedis, KEYS, getGrantByRepoFullName, type GrantRecord } from "./redis";
import { listLinkedWallets } from "./devWallets";
import { getRepoClaim } from "./repoClaims";

/**
 * Author login recorded on a ship report for (repo, sha), if any. Read
 * straight from the attestation layer's Redis record (same key the
 * ship-report API writes) — the report layer stays untouched.
 */
async function loadShipReportAuthor(
  repo: string,
  headSha: string,
): Promise<string | null> {
  const raw = await getRedis().get(KEYS.shipReport(repo, headSha));
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as { authorLogin?: string };
    return record.authorLogin ?? null;
  } catch {
    return null;
  }
}

// ─── Config ──────────────────────────────────────────────────────────────

/** Independent PASS reviews required for a swarm-gated push to count. */
export const SWARM_QUORUM = (() => {
  const raw = parseInt(process.env.SWARM_REVIEW_QUORUM ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
})();

/** Reviews/candidates live for 48h — the existing ship-report window. */
export const SWARM_TTL_SECONDS = 48 * 60 * 60;

// ─── Diff fingerprint ────────────────────────────────────────────────────

export type DiffFileForFingerprint = {
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
  /** Unified-diff patch text for the file, when the source provides it. */
  patch?: string;
};

/**
 * Normalize patch text cheaply: drop blank lines, full-line comments
 * (//, #, /* … *\/, *), and ALL whitespace, so a reformat or a comment
 * edit does not mint a "new" diff. This is a similarity heuristic, not
 * a parser — the exact-duplicate check is its hard guarantee.
 */
export function normalizePatchText(patch: string): string {
  return patch
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter(
      (line) =>
        !line.startsWith("//") &&
        !line.startsWith("#") &&
        !line.startsWith("/*") &&
        !line.startsWith("*") &&
        !line.startsWith("*/"),
    )
    .join("\n")
    .replace(/\s+/g, "");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Per-file fingerprint: filename + status + normalized content. */
export function fileFingerprint(file: DiffFileForFingerprint): string {
  const content = file.patch
    ? normalizePatchText(file.patch)
    : `+${file.additions ?? 0}/-${file.deletions ?? 0}`;
  return sha256Hex(`${file.filename}|${file.status}|${content}`);
}

/**
 * Whole-diff fingerprint: sha256 over the sorted per-file fingerprints.
 * Two diffs with the same files, same statuses, and same normalized
 * content produce the same fingerprint regardless of file order.
 */
export function computeDiffFingerprint(files: DiffFileForFingerprint[]): string {
  const perFile = files.map(fileFingerprint).sort();
  return sha256Hex(perFile.join("\n"));
}

// ─── Records ─────────────────────────────────────────────────────────────

export type ReviewerEnrollment = {
  githubLogin: string;
  /** Reviewer's most recently linked wallet at enrolment time. */
  wallet: string;
  enrolledAt: string;
};

export type PushReview = {
  repo: string;
  headSha: string;
  reviewerLogin: string;
  reviewerWallet: string;
  /** Raw verdict as submitted. */
  verdict: "pass" | "fail";
  different: boolean;
  meaningful: boolean;
  checksPass: boolean;
  /** Effective verdict after normalization (pass needs all three true). */
  effectiveVerdict: "pass" | "fail";
  /** Reviewer's own independently computed whole-diff fingerprint. */
  fingerprint: string;
  note?: string;
  /** Set when the push was already duplicate-flagged at submission. */
  duplicateFlagged?: boolean;
  submittedAt: string;
};

export type SwarmCandidate = {
  repo: string;
  headSha: string;
  authorLogin?: string;
  /** Server-computed fingerprint (PR-credit path), when known. */
  fingerprint?: string;
  duplicateFlagged?: boolean;
  /** Head SHA whose counted diff this push duplicates, when flagged. */
  duplicateOf?: string;
  firstSeenAt: string;
  updatedAt: string;
};

// ─── Storage helpers ─────────────────────────────────────────────────────

async function saveCandidate(candidate: SwarmCandidate): Promise<void> {
  const redis = getRedis();
  await redis.set(
    KEYS.swarmPush(candidate.repo, candidate.headSha),
    JSON.stringify(candidate),
    "EX",
    SWARM_TTL_SECONDS,
  );
  const listKey = KEYS.swarmCandidates(candidate.repo);
  const existing = await redis.lrange(listKey, 0, -1);
  if (!existing.includes(candidate.headSha)) {
    await redis.lpush(listKey, candidate.headSha);
    await redis.ltrim(listKey, 0, 49);
  }
  await redis.expire(listKey, SWARM_TTL_SECONDS);
}

export async function loadCandidate(
  repo: string,
  headSha: string,
): Promise<SwarmCandidate | null> {
  const raw = await getRedis().get(KEYS.swarmPush(repo, headSha));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SwarmCandidate;
  } catch {
    return null;
  }
}

/**
 * Record/refresh what the server knows about a push (author + server
 * fingerprint), from the webhook counting path or from a review
 * submission. Also runs the duplicate check against the repo's counted
 * fingerprints and flags the candidate. Never throws into callers.
 */
export async function noteSwarmCandidate(args: {
  repo: string;
  headSha: string;
  authorLogin?: string;
  fingerprint?: string;
}): Promise<SwarmCandidate> {
  const repo = args.repo;
  const headSha = args.headSha.toLowerCase();
  const existing = await loadCandidate(repo, headSha);
  const candidate: SwarmCandidate = {
    repo,
    headSha,
    authorLogin: args.authorLogin ?? existing?.authorLogin,
    fingerprint: args.fingerprint ?? existing?.fingerprint,
    duplicateFlagged: existing?.duplicateFlagged,
    duplicateOf: existing?.duplicateOf,
    firstSeenAt: existing?.firstSeenAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (candidate.fingerprint) {
    const priorSha = await getRedis().hget(
      KEYS.swarmCountedFingerprints(repo),
      candidate.fingerprint,
    );
    if (priorSha && priorSha.toLowerCase() !== headSha) {
      candidate.duplicateFlagged = true;
      candidate.duplicateOf = priorSha.toLowerCase();
    }
  }

  await saveCandidate(candidate);
  return candidate;
}

/** Fingerprint of a counted diff → its head SHA, per repo (uniqueness ledger). */
export async function recordCountedFingerprint(
  repo: string,
  headSha: string,
  fingerprint: string,
): Promise<void> {
  await getRedis().hset(
    KEYS.swarmCountedFingerprints(repo),
    fingerprint,
    headSha.toLowerCase(),
  );
}

export async function listReviews(repo: string, headSha: string): Promise<PushReview[]> {
  const raw = await getRedis().get(KEYS.swarmReviews(repo, headSha));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as PushReview[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveReviews(repo: string, headSha: string, list: PushReview[]): Promise<void> {
  await getRedis().set(
    KEYS.swarmReviews(repo, headSha),
    JSON.stringify(list),
    "EX",
    SWARM_TTL_SECONDS,
  );
}

// ─── Enrolment ───────────────────────────────────────────────────────────

export async function getReviewerEnrollment(
  githubLogin: string,
): Promise<ReviewerEnrollment | null> {
  const raw = await getRedis().get(KEYS.swarmReviewer(githubLogin));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReviewerEnrollment;
  } catch {
    return null;
  }
}

export type EnrollResult =
  | { ok: true; enrollment: ReviewerEnrollment }
  | { ok: false; code: string; error: string };

/**
 * Enrol an agent as a reviewer. Requires a wallet LINKED to the login
 * (the link-wallet store is signature/magic-link proven, so enrolment
 * binds reviewer identity → payout wallet with evidence). Gate-verified
 * identities (launch gate) are preferred in docs, but the hard
 * requirement enforced here is the linked wallet.
 */
export async function enrollReviewer(args: {
  githubLogin: string;
  wallet: string;
}): Promise<EnrollResult> {
  const login = args.githubLogin.trim();
  const wallet = args.wallet.trim().toLowerCase();
  const linked = await listLinkedWallets(login);
  if (!linked.some((w) => w.wallet === wallet)) {
    return {
      ok: false,
      code: "SWARM_WALLET_NOT_LINKED",
      error:
        `Wallet ${wallet} is not linked to @${login}. Link a wallet first ` +
        `(signature or magic-link flow), then enrol — reviewer rewards pay the linked wallet.`,
    };
  }
  const enrollment: ReviewerEnrollment = {
    githubLogin: login,
    wallet,
    enrolledAt: new Date().toISOString(),
  };
  await getRedis().set(KEYS.swarmReviewer(login), JSON.stringify(enrollment));
  return { ok: true, enrollment };
}

// ─── Independence ────────────────────────────────────────────────────────

export type IndependenceVerdict =
  | { ok: true }
  | { ok: false; code: "SWARM_REVIEW_NOT_INDEPENDENT"; error: string };

/**
 * Resolve every identity a reviewer must be independent OF for a push:
 * the author (candidate record → ship report → grant claim), the
 * author's linked wallets, and the repo's launcher/claim wallets
 * (grant recipient + verified repo-claim wallet).
 */
export async function checkReviewerIndependence(args: {
  repo: string;
  headSha: string;
  reviewerLogin: string;
  reviewerWallet: string;
  grant?: GrantRecord | null;
}): Promise<IndependenceVerdict> {
  const reviewerLogin = args.reviewerLogin.toLowerCase();
  const reviewerWallet = args.reviewerWallet.toLowerCase();
  const refuse = (why: string): IndependenceVerdict => ({
    ok: false,
    code: "SWARM_REVIEW_NOT_INDEPENDENT",
    error: `Reviewer is not independent of this push: ${why}. Self-review and same-wallet review are refused.`,
  });

  const grant =
    args.grant !== undefined ? args.grant : await getGrantByRepoFullName(args.repo);

  // Launcher / claim wallets.
  if (grant && grant.recipient.toLowerCase() === reviewerWallet) {
    return refuse("reviewer wallet is the repo's grant recipient (launcher) wallet");
  }
  const claim = await getRepoClaim(args.repo).catch(() => null);
  if (claim && claim.wallet.toLowerCase() === reviewerWallet) {
    return refuse("reviewer wallet is the repo's claim wallet");
  }
  if (claim && claim.githubLogin.toLowerCase() === reviewerLogin) {
    return refuse("reviewer login is the repo's claim login");
  }

  // Author identity: candidate record first, then the ship report.
  const candidate = await loadCandidate(args.repo, args.headSha);
  let authorLogin = candidate?.authorLogin;
  if (!authorLogin) {
    authorLogin = (await loadShipReportAuthor(args.repo, args.headSha)) ?? undefined;
  }
  if (authorLogin) {
    if (authorLogin.toLowerCase() === reviewerLogin) {
      return refuse("reviewer is the push author");
    }
    const authorWallets = await listLinkedWallets(authorLogin);
    if (authorWallets.some((w) => w.wallet === reviewerWallet)) {
      return refuse("reviewer wallet is linked to the push author");
    }
  }

  return { ok: true };
}

// ─── Review submission ───────────────────────────────────────────────────

export type SubmitReviewResult =
  | { ok: true; review: PushReview; alreadySubmitted?: boolean; quorum: QuorumStatus }
  | { ok: false; code: string; error: string };

export type QuorumStatus = {
  required: number;
  passCount: number;
  failCount: number;
  duplicateFlagged: boolean;
  met: boolean;
  blocked: boolean;
};

/**
 * Store one reviewer's attestation for a push. Moves NO money and
 * counts NOTHING — see the design law in the header. The webhook path
 * consults the stored reviews later (evaluateSwarmGate).
 */
export async function submitReview(args: {
  repo: string;
  headSha: string;
  reviewerLogin: string;
  verdict: "pass" | "fail";
  different: boolean;
  meaningful: boolean;
  checksPass: boolean;
  fingerprint: string;
  note?: string;
  grant?: GrantRecord | null;
}): Promise<SubmitReviewResult> {
  const repo = args.repo;
  const headSha = args.headSha.toLowerCase();
  const reviewerLogin = args.reviewerLogin.trim();

  const enrollment = await getReviewerEnrollment(reviewerLogin);
  if (!enrollment) {
    return {
      ok: false,
      code: "SWARM_NOT_ENROLLED",
      error:
        `@${reviewerLogin} is not enrolled as a swarm reviewer. ` +
        `Enrol first (POST /api/agent/enrol-reviewer or the enrol_reviewer MCP tool).`,
    };
  }

  const independence = await checkReviewerIndependence({
    repo,
    headSha,
    reviewerLogin,
    reviewerWallet: enrollment.wallet,
    grant: args.grant,
  });
  if (!independence.ok) return independence;

  // One review per reviewer per push: resubmission returns the stored
  // review untouched (a reviewer cannot flip a verdict after the fact).
  const existing = await listReviews(repo, headSha);
  const prior = existing.find(
    (r) => r.reviewerLogin.toLowerCase() === reviewerLogin.toLowerCase(),
  );
  if (prior) {
    const quorum = await evaluateQuorum(repo, headSha, undefined);
    return { ok: true, review: prior, alreadySubmitted: true, quorum };
  }

  const candidate = await noteSwarmCandidate({ repo, headSha });

  const effectiveVerdict: "pass" | "fail" =
    args.verdict === "pass" && args.different && args.meaningful && args.checksPass
      ? "pass"
      : "fail";

  const review: PushReview = {
    repo,
    headSha,
    reviewerLogin,
    reviewerWallet: enrollment.wallet,
    verdict: args.verdict,
    different: args.different,
    meaningful: args.meaningful,
    checksPass: args.checksPass,
    effectiveVerdict,
    fingerprint: args.fingerprint.toLowerCase(),
    ...(args.note ? { note: args.note } : {}),
    ...(candidate.duplicateFlagged ? { duplicateFlagged: true } : {}),
    submittedAt: new Date().toISOString(),
  };
  existing.push(review);
  await saveReviews(repo, headSha, existing);

  const quorum = await evaluateQuorum(repo, headSha, candidate.fingerprint);
  return { ok: true, review, quorum };
}

// ─── Quorum evaluation ───────────────────────────────────────────────────

/**
 * Count the reviews that may legitimately gate a push: enrolled at
 * submission time (wallet on the record), and — when the server has its
 * own fingerprint for the push — only PASS reviews whose fingerprint
 * matches the server's (a mismatched PASS reviewed different code).
 * When the server has no fingerprint (raw-push path), PASS reviews must
 * agree with the first PASS review's fingerprint.
 */
export async function evaluateQuorum(
  repo: string,
  headSha: string,
  serverFingerprint?: string,
): Promise<QuorumStatus> {
  const candidate = await loadCandidate(repo, headSha);
  const reviews = await listReviews(repo, headSha);
  const referenceFp = serverFingerprint ?? candidate?.fingerprint;

  let passCount = 0;
  let failCount = 0;
  let agreedFp = referenceFp;
  for (const review of reviews) {
    if (review.effectiveVerdict === "fail") {
      failCount++;
      continue;
    }
    if (agreedFp) {
      if (review.fingerprint === agreedFp) passCount++;
    } else {
      // No reference yet: the first PASS sets the fingerprint the
      // remaining PASS reviews must agree on.
      agreedFp = review.fingerprint;
      passCount++;
    }
  }

  return {
    required: SWARM_QUORUM,
    passCount,
    failCount,
    duplicateFlagged: Boolean(candidate?.duplicateFlagged),
    met: passCount >= SWARM_QUORUM && failCount === 0,
    blocked: failCount > 0,
  };
}

// ─── The gate (consulted ONLY from the webhook counting path) ────────────

export type SwarmGateVerdict =
  | { ok: true; quorum: QuorumStatus }
  | { ok: false; reason: string; quorum: QuorumStatus };

/**
 * Pre-condition for counting a push on a swarm-required grant. Called
 * from processPush AFTER the verifier has accepted the push and BEFORE
 * it is recorded as counted. Returning not-ok means "do not count
 * (yet/ever)" — the caller logs it as a rejection, like a verifier
 * rejection. This function never counts, never pays, never releases.
 */
export async function evaluateSwarmGate(args: {
  repo: string;
  headSha: string;
  authorLogin?: string;
  fingerprint?: string;
}): Promise<SwarmGateVerdict> {
  const candidate = await noteSwarmCandidate({
    repo: args.repo,
    headSha: args.headSha,
    authorLogin: args.authorLogin,
    fingerprint: args.fingerprint,
  });

  const quorum = await evaluateQuorum(args.repo, args.headSha, candidate.fingerprint);

  if (candidate.duplicateFlagged) {
    return {
      ok: false,
      quorum,
      reason:
        `Swarm review: diff fingerprint ${candidate.fingerprint?.slice(0, 12)}… exactly ` +
        `duplicates a previously counted diff (${candidate.duplicateOf?.slice(0, 7)}) — ` +
        `duplicate code never counts`,
    };
  }
  if (quorum.blocked) {
    return {
      ok: false,
      quorum,
      reason:
        `Swarm review: blocked by ${quorum.failCount} independent FAIL verdict(s) — ` +
        `a FAIL vetoes the push; it does not count`,
    };
  }
  if (!quorum.met) {
    return {
      ok: false,
      quorum,
      reason:
        `Swarm review: awaiting independent reviews (${quorum.passCount}/${quorum.required} PASS) — ` +
        `push not counted yet`,
    };
  }
  return { ok: true, quorum };
}

/** PASS reviewers whose reviews formed the quorum (for oracle rewards). */
export async function quorumReviewers(
  repo: string,
  headSha: string,
): Promise<PushReview[]> {
  const candidate = await loadCandidate(repo, headSha);
  const reviews = await listReviews(repo, headSha);
  let agreedFp = candidate?.fingerprint;
  const passes: PushReview[] = [];
  for (const review of reviews) {
    if (review.effectiveVerdict !== "pass") continue;
    if (agreedFp) {
      if (review.fingerprint === agreedFp) passes.push(review);
    } else {
      agreedFp = review.fingerprint;
      passes.push(review);
    }
  }
  return passes.slice(0, SWARM_QUORUM);
}
