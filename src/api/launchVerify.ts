/**
 * POST /api/launch/verify-github — the launch gate (Step 0 of any launch).
 *
 * Body: { githubLogin, repo, wallet, chain? }
 * Runs the server-side GitHub App verification (src/lib/launchGate.ts):
 * app installed on the repo + login owns/admins the repo + wallet linked
 * to the login. On success returns a short-lived signed verification
 * token bound to {githubLogin, repo, wallet, chainId}. Launch-prep
 * endpoints (prepare-lock / lock / confirm-lock) require that token —
 * without it there is no launch on this platform and no Proof of Dev
 * recognition for a launch done elsewhere.
 */

import type { Request, Response } from "express";
import {
  verifyGithubForLaunch,
  getLauncherRewardEnrollment,
  validateLaunchToken,
} from "../lib/launchGate";
import { parseVestingChain } from "../lib/chains";
import { normalizeRepoFullName } from "../lib/repoId";
import { listAllGrants } from "../lib/redis";
import {
  buildPlatformLaunchInput,
  GREGORY_FEE_RECIPIENT_WALLET,
  type Address,
} from "../lib/launchFeeConfig";
import { readVaultBinding, recordPreparedLaunch } from "../lib/launchRecognition";

/**
 * GET /api/launch/projects — the VERIFIED-LAUNCH listing (recognition
 * rule, Codex review fix 2026-11-25). Only grants stamped
 * `launchVerified` at registration appear here. An ordinary vesting
 * grant (registered through the web wizard with no verification
 * token) is a real lock and appears on the general vesting surfaces
 * (/api/vesting/explore etc., flagged launchVerified:false), but it is
 * NOT listed as a launched project and carries no launch recognition.
 */
export async function handleLaunchedProjects(_req: Request, res: Response): Promise<void> {
  const grants = (await listAllGrants()).filter((g) => g.launchVerified === true);
  res.json({
    ok: true,
    count: grants.length,
    projects: grants.map((g) => ({
      repoFullName: g.repoFullName,
      platform: g.platform ?? "github",
      recipient: g.recipient,
      token: g.token,
      chain: g.chain,
      status: g.status,
      launchVerified: true,
      launchVerifiedLogin: g.launchVerifiedLogin,
      launcherRewardEnrolled: g.launcherRewardEnrolled === true,
      verifiedPushCount: g.verifiedPushCount,
      createdAt: g.createdAt,
    })),
  });
}

/**
 * GET /api/launch/enrollment?repo=owner/name&wallet=0x…
 * Read-only: is this repo+wallet a VERIFIED LAUNCHER enrolled for
 * ShipRewards (dual reward §8B)? Enrolment is written at grant
 * registration when a valid verification token was presented — a launch
 * that skipped the gate has no enrolment record.
 */
export async function handleLaunchEnrollmentLookup(req: Request, res: Response): Promise<void> {
  const repo = String(req.query["repo"] ?? "").trim();
  const wallet = String(req.query["wallet"] ?? req.headers["x-wallet-address"] ?? "").trim();
  if (!repo.includes("/") || !wallet) {
    res.status(400).json({ ok: false, error: "repo (owner/name) and wallet query params required" });
    return;
  }
  const enrollment = await getLauncherRewardEnrollment(repo, wallet);
  res.json({
    ok: true,
    repo: normalizeRepoFullName(repo),
    wallet: wallet.toLowerCase(),
    enrolled: enrollment !== null,
    enrollment,
  });
}

/**
 * POST /api/launch/prepare-launch — the platform LAUNCH-PREP surface
 * (built 2026-11-25, closing the remaining half of Codex finding 1:
 * the gate previously covered no launch surface because none built
 * SDK launch inputs).
 *
 * Body: { repo, wallet?, chain?, verificationToken, feeLockVault,
 *         launch: { ...Bankr SDK launch fields (name, symbol, …) } }
 *
 * REQUIRES a valid launch-gate verification token for the exact
 * repo + wallet + chain — without one, nothing is prepared (403 with
 * the gate's code). On success returns the Bankr SDK launch input
 * built by buildPlatformLaunchInput(): the production 25/75 creator
 * split with the LAUNCHER share (7500 bps) paid to the project's
 * FeeLockVault (never the launcher's raw wallet — fees must not
 * arrive liquid) and Bankr time-vesting explicitly { bps: 0 }.
 * Fail-closed while PLATFORM_REWARD_TREASURY_WALLET is unset (503).
 * This endpoint PREPARES an input only — it never signs, broadcasts,
 * or launches anything.
 *
 * GREGORY EXCEPTION, scoped (Codex round-2): the ONLY launch whose
 * launcher share may go to a raw wallet is the platform's OWN launch,
 * where the verified wallet IS Gregory's fee-recipient wallet — he
 * is the platform, not a launcher, and the 75% position in the
 * template is his platform share. For every other verified wallet
 * the launcher position must be the project's FeeLockVault contract:
 * omitting it, passing the launcher's own wallet, or passing any
 * address without code is refused here.
 *
 * RECOGNITION PIN (Codex round-2): a successful preparation records
 * the prepared fee recipients and the vault's runtime codehash (read
 * on-chain now) as the prepared-launch record. Grant registration
 * later compares the actual launch + vault against this record —
 * preparing an input is no longer the end of the evidence chain.
 */
export async function handlePrepareLaunch(req: Request, res: Response): Promise<void> {
  const repo = String(req.body?.repo ?? req.body?.repoFullName ?? "").trim();
  const wallet = String(
    req.headers["x-wallet-address"] ?? req.body?.wallet ?? req.body?.recipient ?? "",
  ).trim();
  const chain = parseVestingChain(String(req.body?.chain ?? "base"));
  const token = String(
    req.body?.verificationToken ?? req.headers["x-launch-verification"] ?? "",
  ).trim();
  const feeLockVault = String(req.body?.feeLockVault ?? "").trim();
  const launch = (req.body?.launch ?? {}) as Record<string, unknown>;

  if (!repo.includes("/") || !wallet) {
    res.status(400).json({ ok: false, error: "repo (owner/name) and wallet required", code: "LAUNCH_PREPARE_BAD_INPUT" });
    return;
  }

  const verdict = await validateLaunchToken({ token, repo, wallet, chain });
  if (!verdict.ok) {
    res.status(403).json({ ok: false, error: verdict.error, code: verdict.code });
    return;
  }

  const walletLc = wallet.toLowerCase();
  const isPlatformLaunch = walletLc === GREGORY_FEE_RECIPIENT_WALLET.toLowerCase();
  let vaultLc: string | null = null;
  let vaultCodehash: string | null = null;

  if (feeLockVault) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(feeLockVault)) {
      res.status(400).json({
        ok: false,
        error: "feeLockVault is not an address",
        code: "LAUNCH_FEE_VAULT_REQUIRED",
      });
      return;
    }
    vaultLc = feeLockVault.toLowerCase();
    if (vaultLc === walletLc) {
      res.status(400).json({
        ok: false,
        error:
          "feeLockVault is the launcher's own wallet: the launcher share must be paid to the project's FeeLockVault CONTRACT so fees auto-lock — a raw wallet in the launcher position is refused (the only raw-wallet launcher share is Gregory's, on the platform's own launch).",
        code: "LAUNCH_FEE_VAULT_IS_LAUNCHER_WALLET",
      });
      return;
    }
    const binding = await readVaultBinding(chain, vaultLc);
    if (!binding.hasCode || !binding.codehash) {
      res.status(400).json({
        ok: false,
        error:
          `feeLockVault ${vaultLc} has no contract code on ${chain} — the launcher-share recipient must be the deployed FeeLockVault contract, not a wallet or an undeployed address.`,
        code: "LAUNCH_FEE_VAULT_NOT_A_CONTRACT",
      });
      return;
    }
    vaultCodehash = binding.codehash;
  } else if (!isPlatformLaunch) {
    res.status(400).json({
      ok: false,
      error:
        "feeLockVault required: a platform launch names the project's FeeLockVault as the launcher-share fee recipient so trading fees auto-lock instead of arriving liquid (Gregory's fee-lock rule). Deploy/register the vault first, then prepare the launch.",
      code: "LAUNCH_FEE_VAULT_REQUIRED",
    });
    return;
  }

  let launchInput: ReturnType<typeof buildPlatformLaunchInput>;
  try {
    launchInput = buildPlatformLaunchInput(launch, {
      launcher: walletLc as Address,
      ...(vaultLc ? { launcherFeeVault: vaultLc as Address } : {}),
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: "PLATFORM_TREASURY_NOT_CONFIGURED",
    });
    return;
  }

  // Pin the preparation as the recognition record (see header).
  await recordPreparedLaunch({
    repo: normalizeRepoFullName(repo),
    wallet: walletLc,
    chainId: verdict.claims.chainId,
    verificationNonce: verdict.claims.nonce,
    feeLockVault: vaultLc,
    vaultCodehash,
    feeRecipients: launchInput.feeRecipients.map((r) => ({
      recipient: r.recipient.toLowerCase() as Address,
      shareBps: r.shareBps,
    })),
    vestingBps: 0,
    preparedAt: new Date().toISOString(),
  });

  res.json({
    ok: true,
    prepared: true,
    repo: normalizeRepoFullName(repo),
    wallet: walletLc,
    chain,
    githubLogin: verdict.claims.githubLogin,
    feeLockVault: vaultLc,
    ...(isPlatformLaunch && !vaultLc ? { platformLaunch: true } : {}),
    launchInput,
    note: vaultLc
      ? "PREPARED ONLY — unsigned Bankr SDK launch input. Nothing was signed, broadcast, or launched. Fee split: 2500 bps of the creator slice to the platform reward treasury, 7500 bps to the project's fee-lock vault; Bankr time-vesting explicitly off (vesting.bps = 0). The prepared recipients and the vault codehash were recorded; registration will compare the actual launch against them."
      : "PREPARED ONLY — unsigned Bankr SDK launch input for the platform's own launch. Nothing was signed, broadcast, or launched. Fee split: 2500 bps of the creator slice to the platform reward treasury, 7500 bps to Gregory's wallet (the platform share — the scoped raw-wallet exception; launcher launches always use a fee-lock vault). Bankr time-vesting explicitly off (vesting.bps = 0).",
  });
}

export async function handleLaunchVerifyGithub(req: Request, res: Response): Promise<void> {
  const githubLogin = String(req.body?.githubLogin ?? req.body?.login ?? "").trim();
  const repo = String(req.body?.repo ?? req.body?.repoFullName ?? "").trim();
  const wallet = String(
    req.headers["x-wallet-address"] ?? req.body?.wallet ?? req.body?.recipient ?? "",
  ).trim();
  const chain = parseVestingChain(String(req.body?.chain ?? "base"));

  const outcome = await verifyGithubForLaunch({ githubLogin, repo, wallet, chain });
  if (!outcome.ok) {
    const status = outcome.code === "LAUNCH_VERIFY_BAD_INPUT" ? 400 : 403;
    res.status(status).json({
      ok: false,
      error: outcome.error,
      code: outcome.code,
      recognition:
        "No verification, no launch recognition: the grant (if any) registers as an ordinary vesting lock — no launchVerified stamp, no verified-launch listing, no ShipRewards launcher enrolment.",
    });
    return;
  }

  res.json({
    ok: true,
    verified: true,
    githubLogin: outcome.claims.githubLogin,
    repo: normalizeRepoFullName(repo),
    wallet: outcome.claims.wallet,
    chainId: outcome.claims.chainId,
    installationId: outcome.claims.installationId,
    verificationToken: outcome.token,
    expiresAt: outcome.expiresAt,
    expiresInSec: outcome.claims.exp - outcome.claims.iat,
    next: "Present verificationToken to POST /api/agent/prepare-lock, /api/agent/lock and /api/agent/confirm-lock (body field or x-launch-verification header) before it expires.",
  });
}
