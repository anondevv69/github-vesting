/**
 * Process repo-claim pushes from GitHub webhooks.
 */

import type { RepoClaimRecord } from "../lib/redis";
import type { PushPayload } from "./pushVerifier";
import {
  CLAIM_FILE_PATH,
  fetchClaimFileFromGithub,
  getRepoClaim,
  markClaimVerified,
  parseClaimFileJson,
  pushTouchesClaimFile,
  verifyClaimFile,
} from "../lib/repoClaims";

export type RepoClaimPushResult =
  | { processed: false }
  | { processed: true; verified: boolean; reason: string; claim?: RepoClaimRecord };

type PushPayloadWithSender = PushPayload & {
  sender?: { login?: string };
};

export async function processRepoClaimFromPush(
  payload: PushPayloadWithSender,
): Promise<RepoClaimPushResult> {
  const repoFullName = payload.repository?.full_name;
  if (!repoFullName || !payload.commits?.length) return { processed: false };

  if (!pushTouchesClaimFile(payload.commits)) return { processed: false };

  const githubLogin = payload.sender?.login ?? payload.pusher?.name ?? "unknown";
  const headSha =
    payload.after?.toLowerCase() ??
    payload.commits[payload.commits.length - 1]?.id?.toLowerCase() ??
    "";

  const raw = await fetchClaimFileFromGithub(repoFullName);
  if (!raw) {
    return {
      processed: true,
      verified: false,
      reason: `${CLAIM_FILE_PATH} not found on repo after push`,
    };
  }

  const file = parseClaimFileJson(raw);
  if (!file) {
    return { processed: true, verified: false, reason: "invalid claim.json format" };
  }

  const check = await verifyClaimFile(file, repoFullName);
  if (!check.ok) {
    return { processed: true, verified: false, reason: check.error };
  }

  const claim = await markClaimVerified(
    repoFullName,
    check.wallet,
    check.claimId,
    githubLogin,
    headSha,
  );

  console.log(
    `[repo-claim] verified ${repoFullName} wallet=${check.wallet} github=@${githubLogin}`,
  );

  return {
    processed: true,
    verified: true,
    reason: `Repo claim verified for @${githubLogin}`,
    claim,
  };
}

export async function tryVerifyClaimFromGithub(
  repoFullName: string,
  githubLoginHint?: string,
): Promise<RepoClaimRecord | null> {
  const existing = await getRepoClaim(repoFullName);
  if (existing?.status === "verified") return existing;

  const raw = await fetchClaimFileFromGithub(repoFullName);
  if (!raw) return existing;

  const file = parseClaimFileJson(raw);
  if (!file) return existing;

  const check = await verifyClaimFile(file, repoFullName);
  if (!check.ok) return existing;

  return markClaimVerified(
    repoFullName,
    check.wallet,
    check.claimId,
    githubLoginHint ?? "unknown",
    "polled",
  );
}
