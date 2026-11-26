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
import { parseVestingChain, getVestingChainConfig } from "../lib/chains";
import { normalizeRepoFullName, repoIdFromFullName } from "../lib/repoId";
import { listAllGrants } from "../lib/redis";
import {
  buildPlatformLaunchInput,
  GREGORY_FEE_RECIPIENT_WALLET,
  type Address,
} from "../lib/launchFeeConfig";
import {
  canonicalVaultCodehash,
  readVaultBinding,
  readFeeGrant,
  recordPreparedLaunch,
} from "../lib/launchRecognition";
import { issueCountAttestation } from "../lib/countAttestation";
import { onboardProjectLaunch, LaunchOnboardError } from "../lib/launchOnboarding";

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
 * RECOGNITION PIN (Codex round-2, hardened round-3): a successful
 * preparation records the prepared fee recipients, the vault's
 * approved-implementation hash, and the verification lineage (login,
 * token nonce, token issued-at) as the prepared-launch record. The
 * vault must be an instance of the ONE approved FeeLockVault
 * implementation — a supplied contract whose implementation hash
 * differs is refused (LAUNCH_VAULT_NOT_APPROVED_IMPL); pinning an
 * arbitrary contract's hash is not identity. Grant registration
 * later REQUIRES this record and compares the actual launch + vault
 * against it — preparing an input is no longer the end of the
 * evidence chain.
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
  let feeGrantPushesPerTranche: number | null = null;

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
    if (!binding.hasCode || !binding.implCodehash) {
      res.status(400).json({
        ok: false,
        error:
          `feeLockVault ${vaultLc} has no contract code on ${chain} — the launcher-share recipient must be the deployed FeeLockVault contract, not a wallet or an undeployed address.`,
        code: "LAUNCH_FEE_VAULT_NOT_A_CONTRACT",
      });
      return;
    }
    // Canonical implementation check (Codex round-3, blocker 2):
    // the vault must be an instance of the ONE approved FeeLockVault
    // implementation (masked-template hash — see launchRecognition).
    // Pinning whatever hash an arbitrary supplied contract happens
    // to have proves continuity, not identity, and is refused.
    if (binding.implCodehash !== canonicalVaultCodehash()) {
      res.status(400).json({
        ok: false,
        error:
          `feeLockVault ${vaultLc} is not an instance of the approved FeeLockVault implementation (implementation hash ${binding.implCodehash}, expected ${canonicalVaultCodehash()}). Only vaults deployed from the platform's approved implementation can receive a launcher fee share.`,
        code: "LAUNCH_VAULT_NOT_APPROVED_IMPL",
      });
      return;
    }
    vaultCodehash = canonicalVaultCodehash();

    // Binding validation (Codex round-4, blocker 3): a genuine
    // instance of the approved implementation can still be bound to
    // the WRONG project — its immutables are set at deployment.
    // Round 3 caught that only at registration, after the user may
    // already have signed a launch routing fees to the vault.
    // Prepare therefore reads and validates EVERY immutable binding
    // against this request and the chain's configuration BEFORE any
    // launch input is built. Any mismatch (or an unreadable binding)
    // refuses here.
    const cfg = getVestingChainConfig(chain);
    const expectedRepoId = repoIdFromFullName(normalizeRepoFullName(repo));
    const bindingChecks: Array<{
      ok: boolean;
      code: string;
      error: string;
    }> = [
      {
        ok: binding.repoId === expectedRepoId,
        code: "LAUNCH_VAULT_REPO_MISMATCH",
        error: `feeLockVault ${vaultLc} is bound to repo ${binding.repoId ?? "unreadable"}, not ${expectedRepoId} (${normalizeRepoFullName(repo)}). The vault was deployed for a different project; deploy the vault for THIS repo first.`,
      },
      {
        ok: binding.launcher === walletLc,
        code: "LAUNCH_VAULT_LAUNCHER_MISMATCH",
        error: `feeLockVault ${vaultLc} is bound to launcher ${binding.launcher ?? "unreadable"}, not the verified wallet ${walletLc}. Its fee releases would pay a different wallet.`,
      },
      {
        ok:
          !!cfg.feeStreamEscrowAddress &&
          binding.escrow === cfg.feeStreamEscrowAddress.toLowerCase(),
        code: "LAUNCH_VAULT_ESCROW_MISMATCH",
        error: `feeLockVault ${vaultLc} locks into escrow ${binding.escrow ?? "unreadable"}, not the chain's configured FeeStreamEscrow (${cfg.feeStreamEscrowAddress ?? "not configured"}). Tranches locked there are outside the platform's fee-stream grants.`,
      },
      {
        ok: !!cfg.wethAddress && binding.feeToken === cfg.wethAddress.toLowerCase(),
        code: "LAUNCH_VAULT_TOKEN_MISMATCH",
        error: `feeLockVault ${vaultLc} is bound to fee token ${binding.feeToken ?? "unreadable"}, not the chain's configured WETH (${cfg.wethAddress ?? "not configured"}). Platform fee grants are denominated in WETH.`,
      },
      {
        ok:
          !!cfg.bankrClaimLedgerAddress &&
          binding.claimLedger === cfg.bankrClaimLedgerAddress.toLowerCase(),
        code: "LAUNCH_VAULT_LEDGER_MISMATCH",
        error: `feeLockVault ${vaultLc} claims from ledger ${binding.claimLedger ?? "unreadable"}, not the configured Bankr claim ledger (${cfg.bankrClaimLedgerAddress ?? "not configured"}). Its claims would not execute against the real Bankr fee ledger.`,
      },
    ];
    for (const c of bindingChecks) {
      if (!c.ok) {
        res.status(400).json({ ok: false, error: c.error, code: c.code });
        return;
      }
    }

    // Registrar pre-launch grant check (Codex round-4, blocker 3):
    // the matching fee grant must ALREADY be registered in the
    // escrow for this repo — recipient, vault, token, and
    // pushesPerTranche matching the prepared configuration.
    // Onboarding order is therefore: platform deploys the vault →
    // registrar registers the fee grant → prepare verifies grant +
    // bindings → launch input returned. A launch prepared before
    // its grant exists would route fees into a grant that may never
    // be registered; that ordering is refused here, not discovered
    // at registration.
    const grant = await readFeeGrant(chain, expectedRepoId);
    if (!grant || !grant.registered) {
      res.status(400).json({
        ok: false,
        error:
          `No fee grant is registered in the FeeStreamEscrow for ${normalizeRepoFullName(repo)} — the registrar must register the project's fee grant (recipient, token, vault, pushesPerTranche) before a launch can be prepared.`,
        code: "LAUNCH_FEE_GRANT_NOT_REGISTERED",
      });
      return;
    }
    const expectedPptRaw = req.body?.feePushesPerTranche;
    const expectedPpt =
      expectedPptRaw === undefined || expectedPptRaw === null
        ? null
        : Number(expectedPptRaw);
    if (
      grant.recipient !== walletLc ||
      grant.vault !== vaultLc ||
      grant.token !== binding.feeToken ||
      (expectedPpt !== null &&
        (!Number.isInteger(expectedPpt) || grant.pushesPerTranche !== expectedPpt))
    ) {
      res.status(400).json({
        ok: false,
        error:
          `The registered fee grant for ${normalizeRepoFullName(repo)} does not match the prepared configuration: grant recipient=${grant.recipient} vault=${grant.vault} token=${grant.token} pushesPerTranche=${grant.pushesPerTranche}; expected recipient=${walletLc} vault=${vaultLc} token=${binding.feeToken}${expectedPpt !== null ? ` pushesPerTranche=${expectedPpt}` : ""}. The registrar must fix the grant before the launch is prepared.`,
        code: "LAUNCH_FEE_GRANT_MISMATCH",
      });
      return;
    }
    feeGrantPushesPerTranche = grant.pushesPerTranche;
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

  // Pin the preparation as the recognition record (see header),
  // including the verification lineage (login + nonce + issued-at)
  // registration binds against — a later fresh token chains to this
  // record; it never replaces it.
  await recordPreparedLaunch({
    repo: normalizeRepoFullName(repo),
    wallet: walletLc,
    chainId: verdict.claims.chainId,
    githubLogin: verdict.claims.githubLogin,
    verificationNonce: verdict.claims.nonce,
    verificationIat: verdict.claims.iat,
    feeLockVault: vaultLc,
    vaultCodehash,
    feeRecipients: launchInput.feeRecipients.map((r) => ({
      recipient: r.recipient.toLowerCase() as Address,
      shareBps: r.shareBps,
    })),
    vestingBps: 0,
    ...(feeGrantPushesPerTranche !== null
      ? { feePushesPerTranche: feeGrantPushesPerTranche }
      : {}),
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
    ...(feeGrantPushesPerTranche !== null
      ? { feePushesPerTranche: feeGrantPushesPerTranche }
      : {}),
    ...(isPlatformLaunch && !vaultLc ? { platformLaunch: true } : {}),
    launchInput,
    note: vaultLc
      ? "PREPARED ONLY — unsigned Bankr SDK launch input. Nothing was signed, broadcast, or launched. Fee split: 2500 bps of the creator slice to the platform reward treasury, 7500 bps to the project's fee-lock vault; Bankr time-vesting explicitly off (vesting.bps = 0). The prepared recipients, the vault's approved-implementation hash, and the verification lineage were recorded; registration will compare the actual launch against them."
      : "PREPARED ONLY — unsigned Bankr SDK launch input for the platform's own launch. Nothing was signed, broadcast, or launched. Fee split: 2500 bps of the creator slice to the platform reward treasury, 7500 bps to Gregory's wallet (the platform share — the scoped raw-wallet exception; launcher launches always use a fee-lock vault). Bankr time-vesting explicitly off (vesting.bps = 0).",
  });
}

/**
 * POST /api/launch/onboard — platform onboarding for a verified
 * launcher (built 2026-11-26, closing the gap the web launch wizard
 * found: prepare-launch required a platform-deployed fee-lock vault
 * and a registrar-registered fee grant, but no endpoint existed to
 * request, trigger, or look them up).
 *
 * Body: { repo, wallet?, chain?, verificationToken, feePushesPerTranche? }
 *
 * AUTH: the SAME launch-gate discipline as prepare-launch — a valid
 * verification token for the exact repo + wallet + chain, validated
 * before anything else. Repo, launcher, and chain are then taken from
 * the VALIDATED CLAIMS, never from caller fields (the body fields are
 * only the binding the token is validated against); escrow, WETH, and
 * the Bankr claim ledger come from server chain config; the vault is
 * deployed by the backend's operator signer from the pinned approved
 * implementation; the fee grant is registered by that same signer in
 * its registrar (escrow-owner) capacity.
 *
 * IDEMPOTENT + RESUMABLE: repeat calls for an onboarded (repo,
 * launcher) return the existing vault and grant; a call after a
 * failed grant registration registers against the recorded vault
 * instead of deploying a second one. See src/lib/launchOnboarding.ts.
 *
 * Response (200): { ok, onboarded, alreadyOnboarded, repo, wallet,
 * chain, githubLogin, feeLockVault, feeGrant: { registered, recipient,
 * token, vault, pushesPerTranche }, deployTxHash?, registerTxHash?,
 * status }
 */
export async function handleLaunchOnboard(req: Request, res: Response): Promise<void> {
  const repo = String(req.body?.repo ?? req.body?.repoFullName ?? "").trim();
  const wallet = String(
    req.headers["x-wallet-address"] ?? req.body?.wallet ?? req.body?.recipient ?? "",
  ).trim();
  const chain = parseVestingChain(String(req.body?.chain ?? "base"));
  const token = String(
    req.body?.verificationToken ?? req.headers["x-launch-verification"] ?? "",
  ).trim();

  if (!repo.includes("/") || !wallet) {
    res.status(400).json({ ok: false, error: "repo (owner/name) and wallet required", code: "LAUNCH_ONBOARD_BAD_INPUT" });
    return;
  }

  const verdict = await validateLaunchToken({ token, repo, wallet, chain });
  if (!verdict.ok) {
    res.status(403).json({ ok: false, error: verdict.error, code: verdict.code });
    return;
  }

  const pptRaw = req.body?.feePushesPerTranche;
  const feePushesPerTranche =
    pptRaw === undefined || pptRaw === null ? null : Number(pptRaw);

  try {
    const result = await onboardProjectLaunch({
      claims: verdict.claims,
      chain,
      feePushesPerTranche,
    });
    res.json({
      ok: true,
      onboarded: true,
      alreadyOnboarded: result.alreadyOnboarded,
      repo: result.record.repo,
      wallet: result.record.wallet,
      chain,
      githubLogin: verdict.claims.githubLogin,
      feeLockVault: result.record.feeLockVault,
      feeGrant: {
        registered: result.feeGrant.registered,
        recipient: result.feeGrant.recipient,
        token: result.feeGrant.token,
        vault: result.feeGrant.vault,
        pushesPerTranche: result.feeGrant.pushesPerTranche,
      },
      ...(result.record.deployTxHash ? { deployTxHash: result.record.deployTxHash } : {}),
      ...(result.record.registerTxHash ? { registerTxHash: result.record.registerTxHash } : {}),
      status: result.record.status,
      note: result.alreadyOnboarded
        ? "Already onboarded — the existing fee-lock vault and registered fee grant for this repo + launcher were returned; nothing was deployed or registered again."
        : "Onboarded — the platform deployed this project's FeeLockVault from the approved implementation and registered its fee grant in the FeeStreamEscrow. prepare-launch will now validate the vault's bindings and the grant.",
    });
  } catch (err) {
    if (err instanceof LaunchOnboardError) {
      res.status(err.status).json({
        ok: false,
        error: err.message,
        code: err.code,
        ...(err.feeLockVault ? { feeLockVault: err.feeLockVault } : {}),
        ...(err.resumable !== undefined ? { resumable: err.resumable } : {}),
      });
      return;
    }
    res.status(503).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: "LAUNCH_ONBOARD_FAILED",
    });
  }
}

/**
 * POST /api/launch/count-attestation — issue an oracle-signed
 * CountAttestation of the backend's counted-push total for a repo
 * (Codex round-4, blocker 1). Body: { repoId? | repo?, vault, chain? }.
 * The fee-lock keeper fetches one immediately before calling
 * vault.lockAccrued; FeeStreamEscrow verifies the oracle signature
 * and bindings on-chain. The attested total is read from the
 * backend's own push counter — the request cannot name a count.
 */
export async function handleCountAttestation(req: Request, res: Response): Promise<void> {
  const vault = String(req.body?.vault ?? "").trim();
  const chain = parseVestingChain(String(req.body?.chain ?? "base"));
  const repoRaw = String(req.body?.repo ?? req.body?.repoFullName ?? "").trim();
  const repoIdRaw = String(req.body?.repoId ?? "").trim().toLowerCase().replace(/^0x/, "");
  const repoId = repoRaw.includes("/")
    ? repoIdFromFullName(normalizeRepoFullName(repoRaw))
    : repoIdRaw;

  if (!/^[0-9a-f]{64}$/.test(repoId) || !/^0x[0-9a-fA-F]{40}$/.test(vault)) {
    res.status(400).json({
      ok: false,
      error: "repo (owner/name) or repoId (bytes32 hex), and vault (address) required",
      code: "COUNT_ATTESTATION_BAD_INPUT",
    });
    return;
  }

  try {
    const issued = await issueCountAttestation({ repoId, vault, chain });
    res.json({
      ok: true,
      chain,
      signer: issued.signer,
      attestation: issued.attestation,
      signature: issued.signature,
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: "COUNT_ATTESTATION_UNAVAILABLE",
    });
  }
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
