/**
 * Reviewer swarm HTTP surface (see lib/swarmReview.ts for the design law):
 *
 *   POST /api/agent/enrol-reviewer   { githubLogin, wallet }
 *   GET  /api/agent/review-queue?repo=&reviewerLogin=
 *   POST /api/agent/review-push      { repo, headSha, reviewerLogin,
 *                                      verdict, different, meaningful,
 *                                      checksPass, fingerprint, note? }
 *   GET  /api/agent/push-reviews?repo=&sha=
 *
 * A review is an ATTESTATION, like a ship report: it never moves money,
 * never counts a push, never releases tokens. Settlement remains
 * exactly one path — GitHub push webhook → pushVerifier (+ the swarm
 * gate as a blocking pre-condition) → oracle. Every response carries
 * `settlement: "github-webhook"` and `reviewMovesMoney: false` so no
 * client can mistake a review for a payment.
 */

import type { Request, Response } from "express";
import { getGrantByRepoFullName, getRedis, KEYS } from "../lib/redis";
import { isValidWallet } from "../lib/grantsHelper";
import {
  enrollReviewer,
  submitReview,
  listReviews,
  loadCandidate,
  evaluateQuorum,
  checkReviewerIndependence,
  getReviewerEnrollment,
} from "../lib/swarmReview";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-fA-F]{40}$/;
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
const FINGERPRINT_RE = /^[0-9a-fA-F]{64}$/;

function trustFields() {
  return { settlement: "github-webhook" as const, reviewMovesMoney: false as const };
}

export async function handleEnrolReviewer(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const githubLogin = typeof body.githubLogin === "string" ? body.githubLogin.trim() : "";
  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";

  if (!LOGIN_RE.test(githubLogin)) {
    res.status(400).json({ ok: false, error: "githubLogin required (GitHub login)" });
    return;
  }
  if (!isValidWallet(wallet)) {
    res.status(400).json({ ok: false, error: "wallet required (0x address)" });
    return;
  }

  const result = await enrollReviewer({ githubLogin, wallet });
  if (!result.ok) {
    res.status(403).json({ ok: false, error: result.error, code: result.code });
    return;
  }
  res.json({ ok: true, enrolled: true, enrollment: result.enrollment, ...trustFields() });
}

export async function handleReviewPush(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const headSha = typeof body.headSha === "string" ? body.headSha.trim() : "";
  const reviewerLogin =
    typeof body.reviewerLogin === "string" ? body.reviewerLogin.trim() : "";
  const verdict = body.verdict;
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : undefined;

  if (!REPO_RE.test(repo)) {
    res.status(400).json({ ok: false, error: "repo required, shaped \"owner/repo\"" });
    return;
  }
  if (!SHA_RE.test(headSha)) {
    res.status(400).json({ ok: false, error: "headSha required, 40-char hex commit SHA" });
    return;
  }
  if (!LOGIN_RE.test(reviewerLogin)) {
    res.status(400).json({ ok: false, error: "reviewerLogin required (GitHub login)" });
    return;
  }
  if (verdict !== "pass" && verdict !== "fail") {
    res.status(400).json({ ok: false, error: "verdict required: \"pass\" or \"fail\"" });
    return;
  }
  for (const field of ["different", "meaningful", "checksPass"] as const) {
    if (typeof body[field] !== "boolean") {
      res.status(400).json({ ok: false, error: `${field} required (boolean)` });
      return;
    }
  }
  if (!FINGERPRINT_RE.test(fingerprint)) {
    res.status(400).json({
      ok: false,
      error: "fingerprint required: the reviewer's own computed whole-diff fingerprint (64-char hex, see the swarm fingerprint algorithm in the skill)",
    });
    return;
  }

  const result = await submitReview({
    repo,
    headSha,
    reviewerLogin,
    verdict,
    different: body.different as boolean,
    meaningful: body.meaningful as boolean,
    checksPass: body.checksPass as boolean,
    fingerprint,
    ...(note ? { note } : {}),
  });

  if (!result.ok) {
    res.status(403).json({ ok: false, error: result.error, code: result.code });
    return;
  }
  res.json({
    ok: true,
    ...(result.alreadySubmitted ? { alreadySubmitted: true } : {}),
    review: result.review,
    quorum: result.quorum,
    ...trustFields(),
  });
}

/**
 * Pushes awaiting review for one repo, filtered for one reviewer:
 * candidates the reviewer is independent of and has not already
 * reviewed, on grants where swarm review is required.
 */
export async function handleReviewQueue(req: Request, res: Response): Promise<void> {
  const repo = String(req.query["repo"] ?? "").trim();
  const reviewerLogin = String(req.query["reviewerLogin"] ?? "").trim();

  if (!REPO_RE.test(repo)) {
    res.status(400).json({ ok: false, error: "repo query param required (owner/repo)" });
    return;
  }
  if (!LOGIN_RE.test(reviewerLogin)) {
    res.status(400).json({ ok: false, error: "reviewerLogin query param required" });
    return;
  }

  const enrollment = await getReviewerEnrollment(reviewerLogin);
  if (!enrollment) {
    res.status(403).json({
      ok: false,
      code: "SWARM_NOT_ENROLLED",
      error: `@${reviewerLogin} is not enrolled as a swarm reviewer`,
    });
    return;
  }

  const grant = await getGrantByRepoFullName(repo);
  if (!grant || grant.swarmReviewRequired !== true) {
    res.json({ ok: true, repo, swarmRequired: false, queue: [], ...trustFields() });
    return;
  }

  const redis = getRedis();
  const shas = await redis.lrange(KEYS.swarmCandidates(repo), 0, 49);
  const queue = [];
  for (const sha of shas) {
    const candidate = await loadCandidate(repo, sha);
    if (!candidate) continue;
    const reviews = await listReviews(repo, sha);
    if (reviews.some((r) => r.reviewerLogin.toLowerCase() === reviewerLogin.toLowerCase())) {
      continue; // already reviewed by this reviewer
    }
    const quorum = await evaluateQuorum(repo, sha, candidate.fingerprint);
    if (quorum.met) continue; // already gate-clear; counting is the webhook's job
    const independence = await checkReviewerIndependence({
      repo,
      headSha: sha,
      reviewerLogin,
      reviewerWallet: enrollment.wallet,
      grant,
    });
    if (!independence.ok) continue; // reviewer must never see own pushes in queue
    queue.push({
      repo,
      headSha: sha,
      authorLogin: candidate.authorLogin,
      fingerprint: candidate.fingerprint,
      duplicateFlagged: Boolean(candidate.duplicateFlagged),
      quorum,
    });
  }

  res.json({ ok: true, repo, swarmRequired: true, queue, ...trustFields() });
}

export async function handleGetPushReviews(req: Request, res: Response): Promise<void> {
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

  const candidate = await loadCandidate(repo, sha);
  const reviews = await listReviews(repo, sha);
  const quorum = await evaluateQuorum(repo, sha, candidate?.fingerprint);
  res.json({
    ok: true,
    repo,
    headSha: sha.toLowerCase(),
    candidate,
    reviews,
    quorum,
    ...trustFields(),
  });
}
