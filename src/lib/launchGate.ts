/**
 * Launch gate — GitHub App verification BEFORE any launch/deploy.
 *
 * Gregory's rule (2026-11-25): anyone deploying on the Proof of Dev
 * platform, or through an agent (skill / MCP), must pass GitHub App
 * verification FIRST, and only then deploy. An agent's self-assertion
 * ("the app is installed, trust me") is NOT verification — the only
 * check that counts is this server-side one, made with the GitHub App's
 * own credentials against the GitHub API.
 *
 * Verification requires ALL THREE, checked server-side:
 *   (a) the Proof of Dev GitHub App is INSTALLED and can access the
 *       claimed owner/repo (installation lookup + repo access check);
 *   (b) the requesting GitHub login OWNS the repo or is an ADMIN on it
 *       (repo owner match, or collaborator permission === "admin");
 *   (c) the wallet is LINKED to that GitHub login in the link-wallet
 *       store (links are only created by signature/magic-link proofs —
 *       see src/lib/devWallets.ts — so this binds login ↔ wallet with
 *       cryptographic evidence, not a claim).
 *
 * On success the server issues a short-lived (15 min) HMAC-signed token
 * (SESSION_SECRET, the codebase's existing session secret) bound to
 * {githubLogin, repo, wallet, chainId, installationId, exp, nonce}.
 * The nonce is recorded in Redis at issuance; validation re-checks the
 * signature, the expiry, the exact repo+wallet binding, and the stored
 * nonce record — a token minted for repo A / wallet X cannot be
 * replayed for repo B / wallet Y, and a forged token with a valid
 * signature but no issuance record is refused.
 *
 * Recognition rule: a grant with NO valid verification gets NO launch
 * recognition — no launchVerified stamp, no verified-launch listing,
 * no ShipRewards launcher enrolment. (Ordinary vesting registration
 * and push counting toward a lock's own schedule are NOT launch
 * recognition and still work without a token — see LAUNCH-GATE.md's
 * three definitions.) The lock-prep endpoints
 * (POST /api/agent/prepare-lock, /api/agent/lock, /api/agent/confirm-lock)
 * enforce this by requiring the token. Honest boundary: the Bankr SDK
 * itself is permissionless — a launch done entirely outside this
 * platform cannot be stopped on-chain; it simply receives none of the
 * recognition above. (Future hard-gate option: a platform launch-helper
 * contract that checks this signed attestation before calling the SDK.
 * Not built — see LAUNCH-GATE.md.)
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { env } from "./env";
import { getRedis, KEYS } from "./redis";
import { isValidWallet } from "./grantsHelper";
import { isWalletLinked } from "./devWallets";
import { getVestingChainConfig, type VestingChainKey } from "./chains";
import { normalizeRepoFullName, splitRepo } from "./repoId";
import {
  resolveInstallationForRepo,
  validateRepoAccess,
  getRepoInfo,
  getCollaboratorPermission,
} from "../github/githubApp";

export const LAUNCH_TOKEN_TTL_SEC = 15 * 60;

export type LaunchVerificationClaims = {
  v: 1;
  githubLogin: string;
  repo: string;
  wallet: string;
  chainId: number;
  installationId: number;
  iat: number;
  exp: number;
  nonce: string;
};

export type VerifyFailure = { ok: false; error: string; code: string };
export type VerifySuccess = {
  ok: true;
  token: string;
  claims: LaunchVerificationClaims;
  expiresAt: string;
};
export type VerifyOutcome = VerifySuccess | VerifyFailure;

function fail(error: string, code: string): VerifyFailure {
  return { ok: false, error, code };
}

function hmac(payloadB64: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(payloadB64).digest("base64url");
}

function encodeToken(claims: LaunchVerificationClaims): string {
  const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payloadB64}.${hmac(payloadB64)}`;
}

function decodeAndCheckSignature(
  token: string,
): { ok: true; claims: LaunchVerificationClaims } | VerifyFailure {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return fail("Malformed launch verification token", "LAUNCH_TOKEN_MALFORMED");
  }
  const expected = hmac(parts[0]);
  const got = Buffer.from(parts[1]);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return fail("Invalid launch verification token signature", "LAUNCH_TOKEN_BAD_SIGNATURE");
  }
  try {
    const claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as LaunchVerificationClaims;
    if (claims.v !== 1 || !claims.githubLogin || !claims.repo || !claims.wallet || !claims.nonce) {
      return fail("Malformed launch verification token payload", "LAUNCH_TOKEN_MALFORMED");
    }
    return { ok: true, claims };
  } catch {
    return fail("Malformed launch verification token payload", "LAUNCH_TOKEN_MALFORMED");
  }
}

/**
 * Run the three server-side checks and, if all pass, issue a token.
 * `chain` decides the chainId the token binds to.
 */
export async function verifyGithubForLaunch(input: {
  githubLogin: string;
  repo: string;
  wallet: string;
  chain: VestingChainKey;
}): Promise<VerifyOutcome> {
  const login = String(input.githubLogin ?? "").trim().toLowerCase();
  const wallet = String(input.wallet ?? "").trim().toLowerCase();
  const repoRaw = String(input.repo ?? "").trim();
  if (!login) return fail("githubLogin required", "LAUNCH_VERIFY_BAD_INPUT");
  if (!repoRaw.includes("/")) return fail("repo required (owner/name)", "LAUNCH_VERIFY_BAD_INPUT");
  if (!isValidWallet(wallet)) return fail("wallet required (0x…)", "LAUNCH_VERIFY_BAD_INPUT");
  if (!env.SESSION_SECRET) {
    return fail("Server is not configured to issue launch verification tokens (SESSION_SECRET unset)", "LAUNCH_VERIFY_UNCONFIGURED");
  }

  const repo = normalizeRepoFullName(repoRaw);
  const [owner, repoName] = splitRepo(repo, "github");

  // (a) App installed + can access the repo.
  const installationId = await resolveInstallationForRepo(owner, repoName);
  if (!installationId) {
    return fail(
      `GitHub App is not installed on ${repo} — install the Proof of Dev GitHub App and select this repository, then verify again`,
      "LAUNCH_APP_NOT_INSTALLED",
    );
  }
  const access = await validateRepoAccess(installationId, owner, repoName);
  if (!access.valid) {
    return fail(
      `GitHub App installation ${installationId} cannot access ${repo}: ${access.error ?? "access check failed"}`,
      "LAUNCH_APP_NO_ACCESS",
    );
  }

  // (b) Login owns the repo or is an admin on it.
  let ownsOrAdmins = false;
  try {
    const info = await getRepoInfo(installationId, owner, repoName);
    const ownerLogin = (info as { owner?: { login?: string } }).owner?.login ?? "";
    if (ownerLogin.toLowerCase() === login) ownsOrAdmins = true;
  } catch {
    /* fall through to the collaborator-permission check */
  }
  if (!ownsOrAdmins) {
    const permission = await getCollaboratorPermission(installationId, owner, repoName, login);
    if (permission === "admin") ownsOrAdmins = true;
  }
  if (!ownsOrAdmins) {
    return fail(
      `GitHub login @${login} does not own ${repo} and is not an admin on it — verification requires the repo owner or an admin`,
      "LAUNCH_NOT_OWNER_OR_ADMIN",
    );
  }

  // (c) Wallet linked to that login (signature-proven link store).
  if (!(await isWalletLinked(login, wallet))) {
    return fail(
      `Wallet ${wallet} is not linked to GitHub login @${login} — link the wallet first (POST /api/dev/link-wallet/* or the agent magic-link flow), then verify again`,
      "LAUNCH_WALLET_NOT_LINKED",
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const claims: LaunchVerificationClaims = {
    v: 1,
    githubLogin: login,
    repo: repo.toLowerCase(),
    wallet,
    chainId: getVestingChainConfig(input.chain).chainId,
    installationId,
    iat: nowSec,
    exp: nowSec + LAUNCH_TOKEN_TTL_SEC,
    nonce: randomBytes(16).toString("hex"),
  };
  const token = encodeToken(claims);

  const redis = getRedis();
  await redis.set(
    KEYS.launchVerifyNonce(claims.nonce),
    JSON.stringify(claims),
    "EX",
    LAUNCH_TOKEN_TTL_SEC,
  );
  // Recognition record: the launch-gate evidence other surfaces check.
  await redis.set(
    KEYS.launchVerificationRecord(claims.repo, claims.wallet),
    JSON.stringify({ ...claims, tokenIssuedAt: new Date(nowSec * 1000).toISOString() }),
    "EX",
    LAUNCH_TOKEN_TTL_SEC,
  );

  return { ok: true, token, claims, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

/**
 * Validate a presented token for an exact {repo, wallet, chain} use.
 * Check order is deliberate: signature → expiry → binding → issuance
 * record, so each failure mode reports its own precise reason.
 */
export async function validateLaunchToken(input: {
  token: string;
  repo: string;
  wallet: string;
  chain: VestingChainKey;
}): Promise<{ ok: true; claims: LaunchVerificationClaims } | VerifyFailure> {
  const token = String(input.token ?? "").trim();
  if (!token) {
    return fail(
      "Launch verification required — no verification token presented. Verify first: POST /api/launch/verify-github (or the MCP verify_github tool). An agent's assertion that the GitHub App is installed is not verification.",
      "LAUNCH_VERIFICATION_REQUIRED",
    );
  }
  const decoded = decodeAndCheckSignature(token);
  if (!decoded.ok) return decoded;
  const { claims } = decoded;

  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    return fail("Launch verification token expired — re-run POST /api/launch/verify-github", "LAUNCH_TOKEN_EXPIRED");
  }

  const repo = normalizeRepoFullName(String(input.repo ?? "")).toLowerCase();
  const wallet = String(input.wallet ?? "").trim().toLowerCase();
  if (claims.repo !== repo) {
    return fail(
      `Launch verification token was issued for ${claims.repo}, not ${repo} — tokens are bound to one repo; verify again for this repo`,
      "LAUNCH_TOKEN_REPO_MISMATCH",
    );
  }
  if (claims.wallet !== wallet) {
    return fail(
      `Launch verification token was issued for wallet ${claims.wallet}, not ${wallet} — tokens are bound to one wallet; verify again for this wallet`,
      "LAUNCH_TOKEN_WALLET_MISMATCH",
    );
  }
  const chainId = getVestingChainConfig(input.chain).chainId;
  if (claims.chainId !== chainId) {
    return fail(
      `Launch verification token was issued for chainId ${claims.chainId}, not ${chainId} — verify again for this chain`,
      "LAUNCH_TOKEN_CHAIN_MISMATCH",
    );
  }

  const stored = await getRedis().get(KEYS.launchVerifyNonce(claims.nonce));
  if (!stored) {
    return fail(
      "Launch verification token has no server issuance record (unknown or already-lapsed nonce) — verify again via POST /api/launch/verify-github",
      "LAUNCH_TOKEN_UNKNOWN_NONCE",
    );
  }
  try {
    const record = JSON.parse(stored) as LaunchVerificationClaims;
    if (
      record.githubLogin !== claims.githubLogin ||
      record.repo !== claims.repo ||
      record.wallet !== claims.wallet ||
      record.chainId !== claims.chainId
    ) {
      return fail("Launch verification token does not match its issuance record", "LAUNCH_TOKEN_RECORD_MISMATCH");
    }
  } catch {
    return fail("Launch verification issuance record is unreadable — verify again", "LAUNCH_TOKEN_RECORD_MISMATCH");
  }

  return { ok: true, claims };
}

/** True when a live verification record exists for this repo+wallet. */
export async function hasLaunchVerification(repo: string, wallet: string): Promise<boolean> {
  const raw = await getRedis().get(
    KEYS.launchVerificationRecord(normalizeRepoFullName(repo), wallet.toLowerCase()),
  );
  return raw !== null;
}

// ─── Dual reward (§8B): verified-launcher ShipRewards enrolment ─────────────
//
// Gregory (2026-11-25): people who launch THROUGH Proof of Dev are
// rewarded for pushing code, not only unlocking their own tokens. A
// launcher who passed this gate AND auto-locked is therefore enrolled
// for ShipRewards automatically at grant registration, IN ADDITION TO
// the milestone unlocks of their own token.
//
// CORRECTED (Codex review, 2026-11-25): enrolment is an ELIGIBILITY
// RECORD, not a payout. The rewards path itself (webhook → verifier →
// ShipRewards.pay, per-merge, keyed by merge hash, one payment per
// merge hash) pays the PR AUTHOR's linked wallet — on grant repos and
// grant-less repos alike. That per-merge AUTHOR reward is separate
// and already works; never promise it to a launcher for another
// person's merges.
//
// DECIDED LAUNCHER FEE RULE (Gregory, 2026-11-25): a launcher's
// trading fees must not arrive liquid — their fee share is
// AUTO-LOCKED and unlocks by counted pushes, like their supply lock.
// (a) Today: SDK fee recipients claim LIQUID WETH via buildClaim;
//     nothing auto-locks fees yet.
// (b) Decided: on a Proof of Dev launch the launcher's fee recipient
//     is a per-project fee-lock vault (claim-capable smart account;
//     not the raw wallet, not the escrow contract, which cannot
//     claim); a keeper cycle claims accrued fees and locks them into
//     a fee-stream grant whose tranches unlock over subsequent
//     counted pushes. Denomination open: WETH as claimed, or swapped
//     to the project token via PodSettler.
// (c) Status: BUILT locally (2026-11-25, follow-up pass) —
//     contracts/FeeLockVault.sol + contracts/FeeStreamEscrow.sol,
//     the keeper (scripts/fee-lock-keeper.ts), the oracle release
//     step (src/oracle/feeLock.ts, hooked into processPush), the
//     vault wired into the launch template (launchFeeConfig) and
//     the gate-enforced launch-prep surface
//     (POST /api/launch/prepare-launch). Proven by
//     tests/e2e/run-fee-lock.sh (31/31). NOT deployed; denomination
//     (WETH as claimed vs swap via PodSettler) is still Gregory's
//     open decision — the vault locks the asset it holds.
// This enrolment record is what distinguishes a VERIFIED LAUNCHER's
// repo+wallet from an ordinary grant, for eligibility/listing
// surfaces. Funding loop (launchpad fees → reward pool) is DESIGNED,
// not operating: the treasury wallet and the production reward token
// are still pending. Reward AMOUNTS are unchanged — the flat
// per-merge schedule is Gregory's open decision (§8B.2), not set here.

export type LauncherRewardEnrollment = {
  repo: string;
  wallet: string;
  githubLogin: string;
  /** The verification token's nonce — the token id this enrolment ties to. */
  verificationNonce: string;
  chainId: number;
  enrolledAt: string;
};

/** Record enrolment for a verified launcher. Called from grant
 *  registration (src/api/register.ts) only after a verification token
 *  has been validated for the exact repo + recipient + chain. */
export async function recordLauncherRewardEnrollment(input: {
  repo: string;
  wallet: string;
  githubLogin: string;
  verificationNonce: string;
  chainId: number;
}): Promise<LauncherRewardEnrollment> {
  const enrollment: LauncherRewardEnrollment = {
    repo: normalizeRepoFullName(input.repo).toLowerCase(),
    wallet: input.wallet.toLowerCase(),
    githubLogin: input.githubLogin.toLowerCase(),
    verificationNonce: input.verificationNonce,
    chainId: input.chainId,
    enrolledAt: new Date().toISOString(),
  };
  await getRedis().set(
    KEYS.launcherRewardEnrollment(enrollment.repo, enrollment.wallet),
    JSON.stringify(enrollment),
  );
  return enrollment;
}

/** The enrolment record for a repo+wallet, or null — an unverified
 *  launch (no gate, no token at registration) has NO enrolment. */
export async function getLauncherRewardEnrollment(
  repo: string,
  wallet: string,
): Promise<LauncherRewardEnrollment | null> {
  const raw = await getRedis().get(
    KEYS.launcherRewardEnrollment(normalizeRepoFullName(repo), wallet.toLowerCase()),
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LauncherRewardEnrollment;
  } catch {
    return null;
  }
}
