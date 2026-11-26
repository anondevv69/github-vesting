/**
 * POST /api/vesting/register
 *
 * Activates vesting after on-chain lock + platform hook (GitHub App or GitLawb webhook).
 */

import type { Request, Response } from "express";
import { createPublicClient, http, parseAbi, parseEventLogs, type Hash } from "viem";
import { env } from "../lib/env";
import {
  getVestingChainConfig,
  knownEscrowAddresses,
  type VestingChainKey,
} from "../lib/chains";
import { saveGrant, getGrant, type GrantRecord } from "../lib/redis";
import { validateRepoAccess, resolveInstallationForRepo } from "../github/githubApp";
import { getRedis, KEYS } from "../lib/redis";
import {
  normalizeRepo,
  repoIdFromPlatform,
  splitRepo,
  type RepoPlatform,
} from "../lib/repoId";
import { verifyGitlawbRepoExists, fetchGitlawbRepo } from "../gitlawb/client";
import { addLinkedWallet } from "../lib/devWallets";
import { detectChainFromLockTx } from "../lib/detectGrantChain";
import { validateLaunchToken, recordLauncherRewardEnrollment } from "../lib/launchGate";
import {
  getPreparedLaunch,
  readVaultBinding,
  readLaunchFeeRecipients,
  feeRecipientsEqual,
} from "../lib/launchRecognition";

const ESCROW_ABI = parseAbi([
  "event Locked(bytes32 indexed repoId, address indexed recipient, address indexed token, uint256 amount, uint256 totalPushesRequired, uint256 releasesPerMilestone, uint256 tokensPerMilestone)",
]);

async function lockTxInfo(
  txHash: string,
  chain: VestingChainKey,
): Promise<{
  repoId: string | null;
  blockTimestampSec: number | null;
  /** True when the tx carries a Locked event, but emitted by a
   *  contract OTHER than the chain's configured escrow — the lock
   *  does not live in the configured v2 escrow (Codex round-2). */
  lockedInWrongEscrow: boolean;
  /** The Locked event's recipient + token (Codex round-3): the
   *  event parsed from the receipt must be the lock THIS
   *  registration describes — same repo, same recipient, same
   *  token — not merely some lock in the configured escrow. */
  eventRecipient: string | null;
  eventToken: string | null;
  /** The escrow contract that emitted the matched Locked event —
   *  recorded on the grant so the release path services the grant
   *  through the escrow it was created under (v1→v2 cutover). */
  eventEscrow: string | null;
}> {
  const empty = {
    repoId: null,
    blockTimestampSec: null,
    lockedInWrongEscrow: false,
    eventRecipient: null,
    eventToken: null,
    eventEscrow: null,
  };
  const cfg = getVestingChainConfig(chain);
  if (!cfg.escrowAddress) return empty;
  try {
    const client = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hash });
    const allLogs = parseEventLogs({ abi: ESCROW_ABI, logs: receipt.logs, eventName: "Locked" });
    // The lock counts only when the Locked event was emitted BY one
    // of the platform's escrows on this chain (address equality): the
    // configured escrow, or the chain's legacy (pre-cutover) escrow —
    // a pre-cutover lock must still parse and register after the
    // repoint, and the grant records WHICH escrow emitted it. A
    // Locked event from any other contract — a different escrow, a
    // lookalike — is not this platform's lock.
    const known = knownEscrowAddresses(chain);
    const logs = allLogs.filter((l) => known.includes(l.address.toLowerCase()));
    // The verified-launch stamp keeps the stricter rule (Codex
    // round-2): the lock must live in the CONFIGURED escrow. A lock
    // in the legacy escrow registers as an ordinary grant but is
    // "wrong escrow" for stamp purposes.
    const inConfigured = logs.some(
      (l) => l.address.toLowerCase() === cfg.escrowAddress!.toLowerCase(),
    );
    const lockedInWrongEscrow = !inConfigured && allLogs.length > 0;
    const repoId = logs[0]?.args?.repoId;
    if (!repoId) return { ...empty, lockedInWrongEscrow };
    // Block timestamp of the lock tx — used by the launch gate's
    // ordering check (the lock must not predate the verification
    // token that stamps the grant). Only available when the
    // registration tx IS a lock tx carrying a Locked event.
    let blockTimestampSec: number | null = null;
    try {
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      blockTimestampSec = Number(block.timestamp);
    } catch { /* timestamp stays null → ordering unprovable for this tx */ }
    return {
      repoId: repoId.slice(2),
      blockTimestampSec,
      lockedInWrongEscrow,
      eventRecipient: logs[0]?.args?.recipient?.toLowerCase() ?? null,
      eventToken: logs[0]?.args?.token?.toLowerCase() ?? null,
      eventEscrow: logs[0]?.address?.toLowerCase() ?? null,
    };
  } catch (err) {
    console.warn("[register] Could not read Locked event from tx:", err);
    return empty;
  }
}

export async function handleRegister(req: Request, res: Response): Promise<void> {
  const body = req.body as Partial<
    GrantRecord & {
      repoFullName: string;
      platform?: RepoPlatform;
      /** Launch gate token (see src/lib/launchGate.ts). When present it is
       *  re-validated here and the grant is stamped launchVerified. The
       *  agent confirm-lock path forwards the caller's token, so SDK/agent
       *  launches are always registered with a validated token. */
      launchVerificationToken?: string;
      /** Reviewer swarm opt-in (see src/lib/swarmReview.ts): when true,
       *  pushes on this grant count only after the independent-reviewer
       *  quorum gate passes. Default OFF. */
      swarmReviewRequired?: boolean;
      /** Fee-lock: the project's FeeLockVault address (the claim-capable
       *  fee recipient named on the launch). Recorded on the grant so
       *  counted pushes run the fee-tranche release step. */
      feeLockVault?: string;
      /** Fee-stream schedule (pushes over which each fee tranche vests). */
      feePushesPerTranche?: number;
    }
  >;

  const platform: RepoPlatform = body.platform === "gitlawb" ? "gitlawb" : "github";
  const {
    repoFullName,
    recipient,
    token,
    chain,
    totalLocked,
    totalPushesRequired,
    pushesPerMilestone,
    tokensPerMilestone,
    onChainTxHash,
    installationId,
    streaming,
    gitlawbOwnerDid,
  } = body;

  if (
    !repoFullName ||
    !recipient ||
    !token ||
    !chain ||
    !totalLocked ||
    !totalPushesRequired ||
    !pushesPerMilestone ||
    !tokensPerMilestone ||
    !onChainTxHash
  ) {
    res.status(400).json({ ok: false, error: "Missing required fields" });
    return;
  }

  if (!["base", "base-sepolia", "robinhood"].includes(chain)) {
    res.status(400).json({ ok: false, error: "chain must be base, base-sepolia, or robinhood" });
    return;
  }

  const normalizedRepo = normalizeRepo(repoFullName, platform);

  // Launch gate (recognition rule): a presented verification token must
  // validate for this exact repo + recipient + chain, or registration is
  // refused. Grants carrying a validated token are stamped launchVerified;
  // a launch with no verification record gets no launch recognition.
  let launchVerifiedLogin: string | undefined;
  let launchVerificationNonce: string | undefined;
  let launchTokenIat: number | undefined;
  let launchTokenChainId: number | undefined;
  if (platform === "github" && body.launchVerificationToken) {
    const verdict = await validateLaunchToken({
      token: body.launchVerificationToken,
      repo: normalizedRepo,
      wallet: recipient,
      chain: chain as VestingChainKey,
    });
    if (!verdict.ok) {
      res.status(403).json({ ok: false, error: verdict.error, code: verdict.code });
      return;
    }
    launchVerifiedLogin = verdict.claims.githubLogin;
    launchVerificationNonce = verdict.claims.nonce;
    launchTokenIat = verdict.claims.iat;
    launchTokenChainId = verdict.claims.chainId;
  }

  const detectedChain = await detectChainFromLockTx(onChainTxHash);
  const chainKey = (detectedChain ?? chain) as VestingChainKey;
  const lockInfo = await lockTxInfo(onChainTxHash, chainKey);
  const repoId = lockInfo.repoId ?? repoIdFromPlatform(platform, repoFullName);

  // Launch-gate checks (Codex rounds 1–3). A stamp asserts "verified
  // FIRST, then locked/launched, with the PREPARED launch input".
  // Every failure below withholds the stamp and the enrolment; the
  // grant still registers as an ordinary vesting lock, and the
  // response carries launchVerification {stamped:false, code} so the
  // reason is never silent.
  let launchOrderingNote: string | undefined;
  let launchOrderingCode: string | undefined;
  const withholdStamp = (code: string, note: string) => {
    console.warn(`[register] Launch stamp withheld for ${normalizedRepo}: ${code} — ${note}`);
    launchOrderingCode = code;
    launchOrderingNote = note;
    launchVerifiedLogin = undefined;
    launchVerificationNonce = undefined;
  };

  // ── Round-3, blocker 1: a prepared-launch record is REQUIRED ──────
  // Recognition no longer rests on ordering alone. The presented
  // token must bind to the prepared record made under the SAME
  // verification lineage:
  //   - a lookup ERROR fails closed (never "no record, skip checks");
  //   - no record at all → LAUNCH_NO_PREPARED_RECORD;
  //   - the record's chain, login, repo, and wallet must equal the
  //     presented token's claims and this registration;
  //   - the presented nonce must either BE the record's nonce, or
  //     CHAIN to it: a fresh token (the 15-minute token expired
  //     between prepare and register) issued to the same
  //     login/repo/wallet/chain at or after the record's
  //     verification time. Ordering is then judged against the
  //     ORIGINAL verification time (effectiveIat), so a lock made
  //     after the original verification is not failed for predating
  //     the fresh token — and a token issued BEFORE the preparation
  //     can never chain to it.
  let prepared: Awaited<ReturnType<typeof getPreparedLaunch>> = null;
  let effectiveIat = launchTokenIat;
  if (launchVerifiedLogin && launchTokenIat !== undefined) {
    let lookupFailed = false;
    try {
      prepared = await getPreparedLaunch(normalizedRepo, recipient);
    } catch (err) {
      lookupFailed = true;
      console.warn(`[register] Prepared-launch lookup failed for ${normalizedRepo}:`, err);
    }
    if (lookupFailed) {
      withholdStamp(
        "LAUNCH_PREPARED_LOOKUP_FAILED",
        "The prepared-launch record lookup FAILED (storage error) — fail-closed: grant registered WITHOUT the launchVerified stamp or launcher enrolment. A lookup error is never treated as 'no record'.",
      );
    } else if (!prepared) {
      withholdStamp(
        "LAUNCH_NO_PREPARED_RECORD",
        "No prepared-launch record exists for this repo+wallet — verified recognition requires the launch to have gone through POST /api/launch/prepare-launch. Grant registered WITHOUT the launchVerified stamp or launcher enrolment (ordinary unstamped grant).",
      );
    } else if (prepared.chainId !== launchTokenChainId) {
      withholdStamp(
        "LAUNCH_PREPARED_CHAIN_MISMATCH",
        `Prepared-launch record is for chain ${prepared.chainId} but the presented verification token is for chain ${launchTokenChainId ?? "unknown"} — grant registered WITHOUT the launchVerified stamp or launcher enrolment.`,
      );
    } else if (
      prepared.githubLogin !== launchVerifiedLogin ||
      prepared.wallet !== recipient.toLowerCase() ||
      prepared.repo !== normalizedRepo.toLowerCase()
    ) {
      withholdStamp(
        "LAUNCH_PREPARED_BINDING_MISMATCH",
        "The prepared-launch record's login/repo/wallet do not match the presented verification token and this registration — grant registered WITHOUT the launchVerified stamp or launcher enrolment.",
      );
    } else if (prepared.verificationNonce !== launchVerificationNonce) {
      if (launchTokenIat >= prepared.verificationIat) {
        // Token-expiry path: fresh token, same lineage — ordering
        // judges against the ORIGINAL verification time.
        effectiveIat = prepared.verificationIat;
      } else {
        withholdStamp(
          "LAUNCH_PREPARED_NONCE_MISMATCH",
          "The presented verification token neither matches the prepared record's nonce nor chains to it (it was issued before the preparation) — grant registered WITHOUT the launchVerified stamp or launcher enrolment.",
        );
      }
    }
  }

  // ── ORDERING (fail-closed): the stamp is granted ONLY when the
  // registration tx is the lock tx itself (it carries a Locked
  // event, so its block timestamp is known) AND that timestamp is
  // >= the effective verification time. Failure shapes: (a)
  // provable predating; (b) unprovable ordering (no Locked event /
  // unreadable block time); (c) the Locked event came from a
  // contract other than the chain's configured escrow.
  if (launchVerifiedLogin && effectiveIat !== undefined) {
    if (lockInfo.lockedInWrongEscrow) {
      withholdStamp(
        "LAUNCH_LOCK_NOT_IN_CONFIGURED_ESCROW",
        "Registration transaction carries a Locked event from a contract that is NOT the chain's configured escrow — the lock does not live in the configured v2 escrow, so the grant registered WITHOUT the launchVerified stamp or launcher enrolment.",
      );
    } else if (lockInfo.blockTimestampSec === null) {
      withholdStamp(
        "LAUNCH_ORDERING_UNPROVABLE",
        "Registration transaction carries no provable lock timestamp (no Locked event) — grant registered WITHOUT the launchVerified stamp or launcher enrolment. Register with the lock transaction itself so ordering (verify → lock) can be proven.",
      );
    } else if (lockInfo.blockTimestampSec < effectiveIat) {
      withholdStamp(
        "LAUNCH_ORDERING_PREDATES_VERIFICATION",
        "Lock transaction predates the verification — grant registered WITHOUT the launchVerified stamp or launcher enrolment. Verify first, then lock, then register.",
      );
    }
  }

  // ── LOCK-EVENT MATCH (round-3, blocker 1): the Locked event parsed
  // from the receipt must be the lock THIS registration describes —
  // same repo, same recipient, same token. A receipt carrying some
  // other lock in the configured escrow proves nothing about this
  // grant.
  if (launchVerifiedLogin && lockInfo.repoId !== null) {
    const expectedRepoId = repoIdFromPlatform(platform, repoFullName).toLowerCase();
    if (lockInfo.repoId.toLowerCase() !== expectedRepoId) {
      withholdStamp(
        "LAUNCH_LOCK_REPO_MISMATCH",
        "The lock transaction's Locked event is for a different repo than this registration — grant registered WITHOUT the launchVerified stamp or launcher enrolment.",
      );
    } else if (lockInfo.eventRecipient !== recipient.toLowerCase()) {
      withholdStamp(
        "LAUNCH_LOCK_RECIPIENT_MISMATCH",
        "The lock transaction's Locked event names a different recipient than this registration — grant registered WITHOUT the launchVerified stamp or launcher enrolment.",
      );
    } else if (lockInfo.eventToken !== token.toLowerCase()) {
      withholdStamp(
        "LAUNCH_LOCK_TOKEN_MISMATCH",
        "The lock transaction's Locked event locks a different token than this registration — grant registered WITHOUT the launchVerified stamp or launcher enrolment.",
      );
    }
  }

  // ── RECOGNITION evidence (round-2 finding 2, round-3 hardened):
  // with the prepared record established above, the stamp
  // additionally requires:
  //   (a) the vault is a contract whose immutable bindings (escrow
  //       destination = the chain's configured FeeStreamEscrow,
  //       repoId, launcher) match this registration;
  //   (b) the vault is an instance of the ONE approved FeeLockVault
  //       implementation — its masked-template implementation hash
  //       equals the canonical hash pinned in the prepared record
  //       (prepare-launch refuses any other implementation, so the
  //       pin IS the canonical hash; an arbitrary contract's own
  //       hash is never accepted as identity);
  //   (c) the token's ACTUAL fee recipients (read from Bankr's
  //       factory + fee ledger) equal the prepared recipients.
  let recognitionFeeLockVault: string | undefined;
  if (launchVerifiedLogin && prepared) {
    const presentedVault =
      typeof body.feeLockVault === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.feeLockVault)
        ? body.feeLockVault.toLowerCase()
        : undefined;
    const vault = presentedVault ?? prepared.feeLockVault ?? undefined;
    // A prepared record with NO vault is the platform's own launch
    // (Gregory exception): no vault exists to bind — only the
    // fee-config comparison applies to it.
    const isPreparedPlatformLaunch = !prepared.feeLockVault && !presentedVault;
    if (!isPreparedPlatformLaunch) {
      if (!vault) {
        withholdStamp(
          "LAUNCH_VAULT_UNVERIFIABLE",
          "A prepared-launch record exists for this repo+wallet but names no fee-lock vault to verify — grant registered WITHOUT the launchVerified stamp or launcher enrolment.",
        );
      } else {
        recognitionFeeLockVault = vault;
        const chainCfg = getVestingChainConfig(chainKey);
        const binding = await readVaultBinding(chainKey, vault);
        if (!binding.hasCode) {
          withholdStamp(
            "LAUNCH_VAULT_NOT_A_CONTRACT",
            `Fee-lock vault ${vault} has no contract code on ${chainKey} — grant registered WITHOUT the launchVerified stamp or launcher enrolment.`,
          );
        } else if (!chainCfg.feeStreamEscrowAddress) {
          withholdStamp(
            "LAUNCH_VAULT_DESTINATION_UNVERIFIABLE",
            `No FeeStreamEscrow is configured for ${chainKey}, so the vault's escrow destination cannot be verified — grant registered WITHOUT the launchVerified stamp or launcher enrolment.`,
          );
        } else if (binding.escrow !== chainCfg.feeStreamEscrowAddress.toLowerCase()) {
          withholdStamp(
            "LAUNCH_VAULT_WRONG_ESCROW",
            `Fee-lock vault ${vault} locks into ${binding.escrow ?? "an unreadable destination"}, not the chain's configured FeeStreamEscrow ${chainCfg.feeStreamEscrowAddress} — grant registered WITHOUT the launchVerified stamp or launcher enrolment.`,
          );
        } else if (binding.repoId !== repoId.toLowerCase()) {
          withholdStamp(
            "LAUNCH_VAULT_REPO_MISMATCH",
            `Fee-lock vault ${vault} is bound to repoId ${binding.repoId ?? "unreadable"}, not this registration's repo — grant registered WITHOUT the launchVerified stamp or launcher enrolment.`,
          );
        } else if (binding.launcher !== recipient.toLowerCase()) {
          withholdStamp(
            "LAUNCH_VAULT_LAUNCHER_MISMATCH",
            `Fee-lock vault ${vault} is bound to launcher ${binding.launcher ?? "unreadable"}, not the grant recipient — grant registered WITHOUT the launchVerified stamp or launcher enrolment.`,
          );
        } else if (
          prepared?.vaultCodehash &&
          binding.implCodehash !== prepared.vaultCodehash
        ) {
          withholdStamp(
            "LAUNCH_VAULT_CODEHASH_MISMATCH",
            `Fee-lock vault ${vault} is not an instance of the approved FeeLockVault implementation pinned at prepare-launch (implementation hash ${binding.implCodehash ?? "unreadable"}, expected ${prepared.vaultCodehash}) — the contract presented at registration is not the implementation that was prepared. Grant registered WITHOUT the launchVerified stamp or launcher enrolment.`,
          );
        }
      }
    }
    if (launchVerifiedLogin && prepared) {
      const actual = await readLaunchFeeRecipients(chainKey, token);
      if (!actual) {
        withholdStamp(
          "LAUNCH_FEE_CONFIG_UNREADABLE",
          "The token's fee configuration could not be read from Bankr's factory/fee ledger, so use of the prepared launch input is unprovable — grant registered WITHOUT the launchVerified stamp or launcher enrolment.",
        );
      } else if (!feeRecipientsEqual(actual, prepared.feeRecipients)) {
        withholdStamp(
          "LAUNCH_FEE_CONFIG_MISMATCH",
          "The token's actual fee recipients do not equal the prepared launch input's recipients — the prepared input was not the one used. Grant registered WITHOUT the launchVerified stamp or launcher enrolment.",
        );
      }
    }
  }
  const existing = await getGrant(repoId);
  if (existing && existing.status === "active") {
    res.status(409).json({ ok: false, error: "Active vesting grant already exists for this repo" });
    return;
  }

  let githubInstallId = Number(installationId ?? 0);

  if (platform === "github") {
    const [owner, repoName] = splitRepo(normalizedRepo, "github");
    let installId = githubInstallId;

    const resolved = await resolveInstallationForRepo(owner, repoName);
    if (resolved) {
      installId = resolved;
    } else if (!installId) {
      res.status(400).json({
        ok: false,
        error: "No GitHub App installation found for this repo",
        repo: normalizedRepo,
        hint: "Install the GitHub App and select this repository during setup.",
      });
      return;
    }

    const access = await validateRepoAccess(installId, owner, repoName);
    if (!access.valid) {
      res.status(400).json({
        ok: false,
        error: "GitHub App cannot access this repo — check installation",
        repo: normalizedRepo,
        installationId: installId,
        detail: access.error,
        installedRepos: access.installedRepos?.slice(0, 30),
        hint:
          access.installedRepos?.length &&
          !access.installedRepos.some((r) => r.toLowerCase() === normalizedRepo.toLowerCase())
            ? `Installation ${installId} does not include ${normalizedRepo}. Re-install the app and add this repo, or use one of: ${access.installedRepos.slice(0, 5).join(", ")}`
            : "Confirm the GitHub App is installed on this repo (not just your account).",
      });
      return;
    }
    githubInstallId = installId;
  } else {
    const exists = await verifyGitlawbRepoExists(normalizedRepo);
    if (!exists) {
      res.status(400).json({
        ok: false,
        error: "GitLawb repo not found on node — create it with `gl repo create` first",
        nodeUrl: "https://node.gitlawb.com",
      });
      return;
    }
  }

  const redis = getRedis();
  await redis.set(KEYS.pushCount(repoId), "0");

  let ownerDid = gitlawbOwnerDid;
  if (platform === "gitlawb" && !ownerDid) {
    const [owner, name] = splitRepo(normalizedRepo, "gitlawb");
    const info = await fetchGitlawbRepo(owner, name);
    ownerDid = info?.ownerDid;
  }

  const now = new Date().toISOString();
  const grant: GrantRecord = {
    repoId,
    repoFullName: normalizedRepo,
    platform,
    recipient,
    token,
    chain: chainKey,
    totalLocked,
    totalPushesRequired: Number(totalPushesRequired),
    pushesPerMilestone: Number(pushesPerMilestone),
    tokensPerMilestone,
    verifiedPushCount: 0,
    lastPaidMilestone: 0,
    onChainTxHash,
    // Per-grant escrow (v1→v2 cutover): the escrow that emitted this
    // grant's Locked event. The release path services the grant
    // through this contract for its whole life, across any later
    // repoint of the chain's configured escrow.
    escrowAddress: lockInfo.eventEscrow ?? undefined,
    installationId: platform === "github" ? githubInstallId : Number(installationId ?? 0),
    launchVerified: launchVerifiedLogin ? true : undefined,
    launchVerifiedLogin,
    launcherRewardEnrolled: launchVerifiedLogin ? true : undefined,
    swarmReviewRequired: body.swarmReviewRequired === true ? true : undefined,
    feeLockVault:
      typeof body.feeLockVault === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.feeLockVault)
        ? body.feeLockVault
        : recognitionFeeLockVault,
    feePushesPerTranche:
      typeof body.feePushesPerTranche === "number" && body.feePushesPerTranche > 0
        ? Math.floor(body.feePushesPerTranche)
        : undefined,
    gitlawbOwnerDid: ownerDid,
    status: "active",
    streaming: Boolean(streaming),
    createdAt: now,
    updatedAt: now,
  };

  await saveGrant(grant);
  console.log(`[register] New ${platform} vesting grant for ${normalizedRepo} by ${recipient}`);

  // Dual reward (§8B): a VERIFIED launcher (valid gate token validated
  // above) is auto-enrolled for ShipRewards on this repo. Enrolment is
  // an eligibility record only — the per-merge ShipRewards payout pays
  // the PR AUTHOR (separate, already working). The launcher's trading
  // fees are governed by Gregory's decided fee-lock rule (auto-locked
  // into a fee-stream grant unlocking by counted pushes) — built
  // locally, see src/lib/launchGate.ts and contracts/FeeLockVault.sol.
  // No token (or a withheld stamp) → no enrolment.
  if (launchVerifiedLogin && launchVerificationNonce) {
    await recordLauncherRewardEnrollment({
      repo: normalizedRepo,
      wallet: recipient,
      githubLogin: launchVerifiedLogin,
      verificationNonce: launchVerificationNonce,
      chainId: getVestingChainConfig(chainKey).chainId,
    });
    console.log(
      `[register] Verified launcher @${launchVerifiedLogin} enrolled for ShipRewards on ${normalizedRepo}`,
    );
  }

  if (platform === "github") {
    const [owner] = splitRepo(normalizedRepo, "github");
    void addLinkedWallet(owner, recipient, "lock").catch(() => {});
  }

  const [owner, repoName] = splitRepo(normalizedRepo, platform);
  const lockPath = `/lock/${owner}/${repoName}`;

  res.json({
    ok: true,
    repoId,
    grant,
    lockPath,
    lockUrl: `${env.FRONTEND_URL}${lockPath}`,
    ...(launchOrderingNote
      ? { launchVerification: { stamped: false, code: launchOrderingCode, note: launchOrderingNote } }
      : {}),
  });
}
