/**
 * PR-credit (Ship spec §8): credit the merged PR, not the raw push.
 *
 * A squash merge lands as ONE push commit and a merge commit bundles many
 * commits — counting raw push commits either under- or over-credits. When a
 * production-branch push is a merged PR, this module:
 *
 *   1. Detects the PR number from the HEAD commit message:
 *        - merge commit:  "Merge pull request #123 from owner/branch"
 *        - squash merge:  "feat: something (#123)"
 *   2. Fetches the PR + its files via the GitHub App installation client.
 *   3. Confirms the PR is actually merged and its merge_commit_sha matches
 *      the push head (when both are known).
 *   4. Returns a normalised single-commit payload (head SHA = merge commit)
 *      plus the PR's real diff line count over meaningful files, so the
 *      existing verifier sees: one merge = at most one counted push.
 *
 * Anything that is not a detectable merged PR returns null and the caller
 * falls back to the existing raw-push verification unchanged. API failures
 * also return null (fail-open to the legacy path, never crash the webhook).
 *
 * Exclusions (diffs that never count) are enforced by pushVerifier's
 * IGNORED_PATTERNS (.claude/**, .proofofdev/**, .github/**, lockfiles, docs):
 * a PR touching only those files yields zero meaningful files/lines here and
 * is rejected by the verifier as docs/lockfiles-only.
 */

import { getGithubApp, resolveInstallationForRepo } from "./githubApp";
import { isMeaningfulFile, type PushPayload } from "./pushVerifier";

export type MergedPrCredit = {
  prNumber: number;
  /** GitHub login of the PR author — the wallet-credit / reward identity. */
  authorLogin: string;
  authorType: string | null;
  /** True when the PR author is a bot / GitHub App account. */
  authorIsBot: boolean;
  mergeCommitSha: string;
  /** Real added+deleted lines across meaningful (non-ignored) files. */
  linesChanged: number;
  meaningfulFiles: Array<{ filename: string; status: string }>;
  /** Single-commit payload normalised for verifyPush / recordVerifiedPush. */
  payload: PushPayload;
};

/** Parse a PR number from a merge / squash-merge head commit message. */
export function parsePrNumberFromMessage(message: string | undefined): number | null {
  if (!message) return null;
  const firstLine = message.split("\n")[0] ?? "";
  const merge = firstLine.match(/^Merge pull request #(\d+)\b/);
  if (merge) return parseInt(merge[1]!, 10);
  const squash = firstLine.match(/\(#(\d+)\)\s*$/);
  if (squash) return parseInt(squash[1]!, 10);
  return null;
}

function headCommit(payload: PushPayload): PushPayload["commits"][number] | null {
  const headSha = (payload.after ?? "").toLowerCase();
  if (headSha) {
    const bySha = payload.commits.find((c) => c.id.toLowerCase() === headSha);
    if (bySha) return bySha;
  }
  return payload.commits[payload.commits.length - 1] ?? null;
}

type PrApiShape = {
  number: number;
  merged_at: string | null;
  merge_commit_sha: string | null;
  title: string;
  user: { login: string; type?: string } | null;
};

type PrFileApiShape = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
};

/**
 * Resolve PR credit for a push, or null when this push is not a merged PR.
 * Never throws — webhook processing must survive GitHub API failures.
 */
export async function resolveMergedPrCredit(
  repoFullName: string,
  payload: PushPayload,
  installationId?: number,
): Promise<MergedPrCredit | null> {
  try {
    const head = headCommit(payload);
    if (!head) return null;

    const prNumber = parsePrNumberFromMessage(head.message);
    if (prNumber === null) return null;

    const slash = repoFullName.indexOf("/");
    if (slash === -1) return null;
    const owner = repoFullName.slice(0, slash);
    const repo = repoFullName.slice(slash + 1);

    const installation =
      installationId && installationId > 0
        ? installationId
        : await resolveInstallationForRepo(owner, repo);
    if (!installation) return null;

    const app = getGithubApp();
    const octokit = await app.getInstallationOctokit(installation);

    // NOTE (typing workaround): @octokit/rest's generated route types make
    // resp.data awkwardly broad in this repo (see pre-existing errors in
    // githubApp.ts). We cast through unknown to the narrow shapes we read —
    // runtime behaviour is the standard request() response either way.
    const prResp = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: prNumber,
    });
    const pr = prResp.data as unknown as PrApiShape;

    if (!pr.merged_at) return null; // PR exists but was never merged.

    const headSha = (payload.after ?? head.id).toLowerCase();
    if (pr.merge_commit_sha && pr.merge_commit_sha.toLowerCase() !== headSha) {
      return null; // This push is not that PR's merge — don't credit it.
    }
    if (!pr.user?.login) return null;

    const filesResp = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner, repo, pull_number: prNumber, per_page: 100 },
    );
    const files = filesResp.data as unknown as PrFileApiShape[];

    // Cap: only the first 100 files are evaluated (API page size). A PR with
    // >100 files is still credited from its first 100 — noted as a stub-level
    // limitation rather than silently paginating here.
    const meaningful = files.filter((f) => isMeaningfulFile(f.filename));
    const linesChanged = meaningful.reduce(
      (sum, f) => sum + (f.additions ?? 0) + (f.deletions ?? 0),
      0,
    );

    const authorLogin = pr.user.login;
    const authorIsBot =
      pr.user.type === "Bot" || authorLogin.endsWith("[bot]");

    const added = meaningful.filter((f) => f.status === "added").map((f) => f.filename);
    const removed = meaningful
      .filter((f) => f.status === "removed")
      .map((f) => f.filename);
    const modified = meaningful
      .filter((f) => f.status !== "added" && f.status !== "removed")
      .map((f) => f.filename);

    const normalized: PushPayload = {
      ref: payload.ref,
      forced: payload.forced,
      after: payload.after ?? head.id,
      commits: [
        {
          id: head.id,
          message: head.message,
          added,
          removed,
          modified,
          timestamp: head.timestamp,
        },
      ],
      repository: payload.repository,
      // Credit the PR author in the push log / counters, not the merger.
      pusher: { name: authorLogin },
      sender: { login: authorLogin, type: pr.user.type },
    };

    return {
      prNumber,
      authorLogin,
      authorType: pr.user.type ?? null,
      authorIsBot,
      mergeCommitSha: headSha,
      linesChanged,
      meaningfulFiles: meaningful.map((f) => ({ filename: f.filename, status: f.status })),
      payload: normalized,
    };
  } catch (err) {
    console.warn(
      `[pr-credit] PR lookup failed for ${repoFullName} — falling back to raw push:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
