/**
 * Launch onboarding — the platform-operator action behind
 * POST /api/launch/onboard (built 2026-11-26, closing the gap the web
 * launch wizard found).
 *
 * prepare-launch requires, before it returns anything signable:
 *   1. a FeeLockVault deployed from the ONE approved implementation,
 *      immutably bound to (repo, launcher, FeeStreamEscrow, WETH,
 *      Bankr claim ledger); and
 *   2. a matching fee grant ALREADY registered in FeeStreamEscrow.
 * Both are platform-operator actions (vault deployment; registrar-only
 * grant registration). Until this module existed there was NO endpoint
 * to request, trigger, or look them up, so a first launch for a new
 * project could not complete self-serve through the wizard or the
 * agent path — a human operator had to deploy + register by hand.
 *
 * This module performs both, exactly once per (repo, launcher):
 *
 *   - Every parameter prepare-launch will later validate is DERIVED:
 *     repo + launcher + chain from the validated launch-gate claims,
 *     escrow / WETH / claim ledger from server chain config, repoId
 *     from the normalized repo name. The caller supplies nothing but
 *     the verification token and (optionally) the fee-tranche
 *     schedule. There is no caller-supplied vault, escrow, token,
 *     ledger, launcher, or implementation — by construction.
 *   - IDEMPOTENT: an already-registered matching grant (or an
 *     onboarding record pointing at one) returns the existing vault;
 *     repeat calls never deploy a second vault and never attempt a
 *     duplicate registration (the escrow would refuse it anyway —
 *     registerFeeGrant is callable once per repo).
 *   - RESUMABLE: the onboarding record is written BEFORE deployment
 *     (with the CREATE address predicted from the operator nonce) and
 *     updated at every step. If grant registration fails after the
 *     vault deployed, the record keeps the vault with status
 *     vault_deployed; a retry registers against THAT vault.
 *   - FAIL-CLOSED: the operator signer must be the FeeStreamEscrow's
 *     owner (its registrar) — checked BEFORE any deployment, so a
 *     mis-keyed backend refuses instead of deploying a vault it could
 *     never register a grant for. Every deployed vault is re-read and
 *     must pass prepare-launch's own validation (canonical masked
 *     template codehash + all five immutable bindings) before its
 *     grant is registered.
 */

import {
  createPublicClient,
  createWalletClient,
  getContractAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "./env";
import { getVestingChainConfig, type VestingChainKey } from "./chains";
import { normalizeRepoFullName, repoIdFromFullName } from "./repoId";
import {
  canonicalVaultCodehash,
  readFeeGrant,
  readVaultBinding,
  type FeeGrantOnChain,
  type VaultBinding,
} from "./launchRecognition";
import {
  getLaunchOnboarding,
  saveLaunchOnboarding,
  type LaunchOnboardingRecord,
} from "./redis";
import type { LaunchVerificationClaims } from "./launchGate";
import { FEE_LOCK_VAULT_ABI, FEE_LOCK_VAULT_BYTECODE } from "./feeLockVaultArtifact";
import { BUILDER_DATA_SUFFIX } from "./builderCode";

/** The platform's default fee-tranche schedule when the caller does
 *  not name one — the schedule every launch fixture and the beta
 *  template use (each fee tranche vests over 2 counted pushes). */
export const DEFAULT_FEE_PUSHES_PER_TRANCHE = 2;

const FEE_STREAM_ESCROW_ABI = parseAbi([
  "function owner() view returns (address)",
  "function registerFeeGrant(bytes32 repoId, address recipient, address token, address vault, uint256 pushesPerTranche)",
]);

export class LaunchOnboardError extends Error {
  status: number;
  code: string;
  feeLockVault?: string;
  resumable?: boolean;
  constructor(status: number, code: string, message: string, extra?: { feeLockVault?: string; resumable?: boolean }) {
    super(message);
    this.status = status;
    this.code = code;
    this.feeLockVault = extra?.feeLockVault;
    this.resumable = extra?.resumable;
  }
}

export type LaunchOnboardResult = {
  alreadyOnboarded: boolean;
  record: LaunchOnboardingRecord;
  feeGrant: FeeGrantOnChain;
};

function clientsFor(chain: VestingChainKey) {
  const cfg = getVestingChainConfig(chain);
  if (!env.ORACLE_PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(env.ORACLE_PRIVATE_KEY.trim())) {
    throw new LaunchOnboardError(
      503,
      "LAUNCH_ONBOARD_UNCONFIGURED",
      "The backend holds no valid operator signer (ORACLE_PRIVATE_KEY) — onboarding cannot deploy a vault or register a grant.",
    );
  }
  const account = privateKeyToAccount(env.ORACLE_PRIVATE_KEY.trim() as Hex);
  const publicClient = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain: cfg.chain,
    transport: http(cfg.rpcUrl),
    dataSuffix: BUILDER_DATA_SUFFIX,
  });
  return { cfg, account, publicClient, walletClient };
}

async function assertOperatorIsRegistrar(
  publicClient: ReturnType<typeof createPublicClient>,
  escrow: string,
  operator: string,
): Promise<void> {
  let owner: string;
  try {
    owner = String(
      await publicClient.readContract({
        address: escrow as Address,
        abi: FEE_STREAM_ESCROW_ABI,
        functionName: "owner",
      }),
    ).toLowerCase();
  } catch {
    throw new LaunchOnboardError(
      503,
      "LAUNCH_ONBOARD_UNCONFIGURED",
      `Could not read the FeeStreamEscrow owner at ${escrow} — onboarding fails closed rather than deploy a vault whose grant it cannot register.`,
    );
  }
  if (owner !== operator.toLowerCase()) {
    throw new LaunchOnboardError(
      503,
      "LAUNCH_ONBOARD_SIGNER_NOT_REGISTRAR",
      `The backend operator signer ${operator} is not the FeeStreamEscrow registrar (owner ${owner}) — grant registration would fail, so no vault was deployed. The production operator key is owner, registrar, and oracle in one; this backend is mis-keyed for onboarding.`,
    );
  }
}

function assertVaultBinding(
  binding: VaultBinding,
  expected: { vault: string; repoId: string; wallet: string; escrow: string; weth: string; claimLedger: string },
): void {
  const vault = expected.vault;
  if (!binding.hasCode || !binding.implCodehash) {
    throw new LaunchOnboardError(
      409,
      "LAUNCH_ONBOARD_VAULT_MISMATCH",
      `Onboarding vault ${vault} has no contract code — refusing to register a grant against it or deploy a replacement over the recorded state.`,
      { feeLockVault: vault, resumable: false },
    );
  }
  if (binding.implCodehash !== canonicalVaultCodehash()) {
    throw new LaunchOnboardError(
      409,
      "LAUNCH_ONBOARD_VAULT_MISMATCH",
      `Onboarding vault ${vault} is not an instance of the approved FeeLockVault implementation (implementation hash ${binding.implCodehash}, expected ${canonicalVaultCodehash()}).`,
      { feeLockVault: vault, resumable: false },
    );
  }
  const checks: Array<[boolean, string]> = [
    [binding.repoId === expected.repoId, `repoId ${binding.repoId ?? "unreadable"} != ${expected.repoId}`],
    [binding.launcher === expected.wallet, `launcher ${binding.launcher ?? "unreadable"} != ${expected.wallet}`],
    [binding.escrow === expected.escrow, `escrow ${binding.escrow ?? "unreadable"} != ${expected.escrow}`],
    [binding.feeToken === expected.weth, `feeToken ${binding.feeToken ?? "unreadable"} != ${expected.weth}`],
    [binding.claimLedger === expected.claimLedger, `claimLedger ${binding.claimLedger ?? "unreadable"} != ${expected.claimLedger}`],
  ];
  for (const [ok, detail] of checks) {
    if (!ok) {
      throw new LaunchOnboardError(
        409,
        "LAUNCH_ONBOARD_VAULT_MISMATCH",
        `Onboarding vault ${vault} binding mismatch: ${detail}. It cannot serve this (repo, launcher); refusing to register its grant or deploy over it.`,
        { feeLockVault: vault, resumable: false },
      );
    }
  }
}

function assertGrantMatches(
  grant: FeeGrantOnChain,
  expected: { wallet: string; vault: string; weth: string; pushesPerTranche?: number },
): void {
  if (
    grant.recipient !== expected.wallet ||
    grant.vault !== expected.vault.toLowerCase() ||
    grant.token !== expected.weth ||
    (expected.pushesPerTranche !== undefined && grant.pushesPerTranche !== expected.pushesPerTranche)
  ) {
    throw new LaunchOnboardError(
      409,
      "LAUNCH_FEE_GRANT_MISMATCH",
      `The registered fee grant does not match this onboarding: grant recipient=${grant.recipient} vault=${grant.vault} token=${grant.token} pushesPerTranche=${grant.pushesPerTranche}; expected recipient=${expected.wallet} vault=${expected.vault.toLowerCase()} token=${expected.weth}${expected.pushesPerTranche !== undefined ? ` pushesPerTranche=${expected.pushesPerTranche}` : ""}. Fee grants register once per repo and cannot be replaced by onboarding.`,
      { feeLockVault: expected.vault },
    );
  }
}

export async function onboardProjectLaunch(input: {
  claims: LaunchVerificationClaims;
  chain: VestingChainKey;
  feePushesPerTranche?: number | null;
}): Promise<LaunchOnboardResult> {
  const repo = normalizeRepoFullName(input.claims.repo).toLowerCase();
  const wallet = input.claims.wallet.toLowerCase();
  const chain = input.chain;
  const { cfg, account, publicClient, walletClient } = clientsFor(chain);

  if (!cfg.feeStreamEscrowAddress || !cfg.wethAddress || !cfg.bankrClaimLedgerAddress) {
    throw new LaunchOnboardError(
      503,
      "LAUNCH_ONBOARD_NOT_CONFIGURED",
      `Launch onboarding is not configured on ${chain}: FeeStreamEscrow, WETH, and the Bankr claim ledger must all be set in server config (feeStreamEscrow=${cfg.feeStreamEscrowAddress ?? "unset"}, weth=${cfg.wethAddress ?? "unset"}, claimLedger=${cfg.bankrClaimLedgerAddress ?? "unset"}).`,
    );
  }
  const escrow = cfg.feeStreamEscrowAddress.toLowerCase();
  const weth = cfg.wethAddress.toLowerCase();
  const claimLedger = cfg.bankrClaimLedgerAddress.toLowerCase();
  const repoId = repoIdFromFullName(repo);
  const repoIdBytes = `0x${repoId}` as Hex;

  const requestedPpt = input.feePushesPerTranche ?? null;
  if (requestedPpt !== null && (!Number.isInteger(requestedPpt) || requestedPpt < 1 || requestedPpt > 10_000)) {
    throw new LaunchOnboardError(
      400,
      "LAUNCH_ONBOARD_BAD_INPUT",
      "feePushesPerTranche must be a positive integer when supplied.",
    );
  }

  let record: LaunchOnboardingRecord | null;
  try {
    record = await getLaunchOnboarding(repo, wallet);
  } catch {
    throw new LaunchOnboardError(
      503,
      "LAUNCH_ONBOARD_LOOKUP_FAILED",
      "The onboarding record lookup failed — failing closed rather than risk deploying a duplicate vault.",
    );
  }
  if (
    record &&
    (record.repoId !== repoId || record.chainId !== cfg.chainId || record.wallet !== wallet)
  ) {
    throw new LaunchOnboardError(
      409,
      "LAUNCH_ONBOARD_RECORD_MISMATCH",
      `The stored onboarding record for ${repo} / ${wallet} names repoId=${record.repoId} chainId=${record.chainId} — refusing to act on a record that does not match the verified claims.`,
      { feeLockVault: record.feeLockVault },
    );
  }

  const existingGrant = await readFeeGrant(chain, repoId);

  // ── Already onboarded on-chain (idempotent return) ─────────────────
  if (existingGrant?.registered) {
    const binding = await readVaultBinding(chain, existingGrant.vault);
    assertVaultBinding(binding, {
      vault: existingGrant.vault,
      repoId,
      wallet,
      escrow,
      weth,
      claimLedger,
    });
    assertGrantMatches(existingGrant, {
      wallet,
      vault: existingGrant.vault,
      weth,
      ...(requestedPpt !== null ? { pushesPerTranche: requestedPpt } : {}),
    });
    if (record && record.feeLockVault.toLowerCase() !== existingGrant.vault.toLowerCase()) {
      throw new LaunchOnboardError(
        409,
        "LAUNCH_ONBOARD_RECORD_MISMATCH",
        `The onboarding record names vault ${record.feeLockVault} but the registered fee grant names ${existingGrant.vault} — refusing to guess which is authoritative.`,
        { feeLockVault: record.feeLockVault },
      );
    }
    const now = new Date().toISOString();
    const complete: LaunchOnboardingRecord = {
      repo,
      wallet,
      chain,
      chainId: cfg.chainId,
      repoId,
      githubLogin: input.claims.githubLogin,
      feeLockVault: existingGrant.vault,
      feePushesPerTranche: existingGrant.pushesPerTranche,
      status: "grant_registered",
      ...(record?.deployTxHash ? { deployTxHash: record.deployTxHash } : {}),
      ...(record?.registerTxHash ? { registerTxHash: record.registerTxHash } : {}),
      createdAt: record?.createdAt ?? now,
      updatedAt: now,
    };
    await saveLaunchOnboarding(complete);
    console.log(
      `[launch-onboard] already onboarded repo=${repo} launcher=${wallet} chain=${chain} vault=${existingGrant.vault} grant=registered pushesPerTranche=${existingGrant.pushesPerTranche}`,
    );
    return { alreadyOnboarded: true, record: complete, feeGrant: existingGrant };
  }

  // ── Resolve the vault: reuse the recorded one, or deploy ───────────
  let vault: string | null = null;
  let deployTxHash: string | undefined = record?.deployTxHash;

  if (record && record.status !== "deployment_failed") {
    const candidate = record.feeLockVault.toLowerCase();
    const binding = await readVaultBinding(chain, candidate);
    if (binding.hasCode) {
      assertVaultBinding(binding, { vault: candidate, repoId, wallet, escrow, weth, claimLedger });
      vault = candidate;
      if (record.status === "deployment_started" || record.status === "vault_deploying") {
        record = { ...record, status: "vault_deployed" };
        await saveLaunchOnboarding(record);
      }
    } else if (record.status === "deployment_started" || record.status === "vault_deploying") {
      // A previous attempt recorded an intent to deploy but the vault
      // is not on-chain. Distinguish in-flight / never-broadcast from
      // a proven failure before anyone deploys again.
      if (record.deployTxHash) {
        let receiptStatus: string | null = null;
        try {
          const receipt = await publicClient.getTransactionReceipt({
            hash: record.deployTxHash as Hex,
          });
          receiptStatus = receipt.status;
        } catch {
          receiptStatus = null;
        }
        if (receiptStatus === null) {
          throw new LaunchOnboardError(
            409,
            "LAUNCH_ONBOARD_IN_PROGRESS",
            `A vault deployment for ${repo} is already in flight (tx ${record.deployTxHash}, predicted vault ${candidate}) — retry shortly; the retry completes onboarding against that vault if it landed.`,
            { feeLockVault: candidate, resumable: true },
          );
        }
        if (receiptStatus !== "success") {
          // Proven failed deployment: no contract exists at the
          // predicted address and the nonce is consumed. Mark it and
          // fall through to a fresh deployment in this same call.
          record = { ...record, status: "deployment_failed", lastError: `deployment tx ${record.deployTxHash} reverted` };
          await saveLaunchOnboarding(record);
        }
      } else {
        const nonceNow = await publicClient.getTransactionCount({ address: account.address });
        if (record.operatorNonce !== undefined && nonceNow > record.operatorNonce) {
          record = {
            ...record,
            status: "deployment_failed",
            lastError: "operator nonce moved past the recorded deployment nonce with no vault on-chain and no tx hash recorded",
          };
          await saveLaunchOnboarding(record);
          throw new LaunchOnboardError(
            503,
            "LAUNCH_ONBOARD_DEPLOYMENT_FAILED",
            `A previous vault deployment for ${repo} cannot be accounted for (no tx hash recorded, operator nonce moved) — nothing was registered. Retry to deploy fresh; this state is recorded and resumable.`,
            { feeLockVault: candidate, resumable: true },
          );
        }
        // Nonce unchanged: the earlier attempt died before broadcast.
        // Fall through and deploy — the predicted address is the same.
      }
    } else {
      throw new LaunchOnboardError(
        409,
        "LAUNCH_ONBOARD_VAULT_MISMATCH",
        `The onboarding record for ${repo} names vault ${candidate} (status ${record.status}) but it has no contract code — refusing to deploy over recorded state or register against it.`,
        { feeLockVault: candidate, resumable: false },
      );
    }
  }

  if (!vault) {
    // Preflight BEFORE deploying: a vault whose grant can never be
    // registered is worse than no vault.
    await assertOperatorIsRegistrar(publicClient, escrow, account.address);

    const ppt = requestedPpt ?? record?.feePushesPerTranche ?? DEFAULT_FEE_PUSHES_PER_TRANCHE;
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    const predicted = getContractAddress({ from: account.address, nonce: BigInt(nonce) }).toLowerCase();
    const now = new Date().toISOString();
    record = {
      repo,
      wallet,
      chain,
      chainId: cfg.chainId,
      repoId,
      githubLogin: input.claims.githubLogin,
      feeLockVault: predicted,
      feePushesPerTranche: ppt,
      status: "deployment_started",
      operatorNonce: nonce,
      createdAt: record?.createdAt ?? now,
      updatedAt: now,
    };
    await saveLaunchOnboarding(record);

    let hash: Hex;
    try {
      hash = await walletClient.deployContract({
        abi: FEE_LOCK_VAULT_ABI,
        bytecode: FEE_LOCK_VAULT_BYTECODE,
        args: [escrow as Address, weth as Address, repoIdBytes, wallet as Address, claimLedger as Address],
      });
    } catch (err) {
      record = {
        ...record,
        status: "deployment_failed",
        lastError: err instanceof Error ? err.message : String(err),
      };
      await saveLaunchOnboarding(record);
      throw new LaunchOnboardError(
        503,
        "LAUNCH_ONBOARD_DEPLOYMENT_FAILED",
        `FeeLockVault deployment for ${repo} failed before a transaction hash was recorded: ${record.lastError}. Retry to resume onboarding.`,
        { feeLockVault: predicted, resumable: true },
      );
    }
    deployTxHash = hash;
    record = { ...record, status: "vault_deploying", deployTxHash: hash };
    await saveLaunchOnboarding(record);
    console.log(
      `[launch-onboard] vault deploying repo=${repo} launcher=${wallet} chain=${chain} vault=${predicted} deployTx=${hash}`,
    );

    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash });
    } catch (err) {
      throw new LaunchOnboardError(
        503,
        "LAUNCH_ONBOARD_DEPLOYMENT_FAILED",
        `FeeLockVault deployment for ${repo} was broadcast (tx ${hash}, predicted vault ${predicted}) but its receipt could not be read: ${err instanceof Error ? err.message : String(err)}. Retry — the retry resumes from the recorded deployment instead of deploying again.`,
        { feeLockVault: predicted, resumable: true },
      );
    }
    if (receipt.status !== "success" || !receipt.contractAddress) {
      record = { ...record, status: "deployment_failed", lastError: `deployment tx ${hash} reverted` };
      await saveLaunchOnboarding(record);
      throw new LaunchOnboardError(
        503,
        "LAUNCH_ONBOARD_DEPLOYMENT_FAILED",
        `FeeLockVault deployment for ${repo} reverted (tx ${hash}). Nothing was registered; retry to deploy fresh.`,
        { feeLockVault: predicted, resumable: true },
      );
    }
    vault = receipt.contractAddress.toLowerCase();
    record = { ...record, feeLockVault: vault, status: "vault_deployed" };
    await saveLaunchOnboarding(record);
    console.log(
      `[launch-onboard] vault deployed repo=${repo} launcher=${wallet} chain=${chain} vault=${vault} deployTx=${hash}`,
    );

    const binding = await readVaultBinding(chain, vault);
    assertVaultBinding(binding, { vault, repoId, wallet, escrow, weth, claimLedger });
  }

  // ── Register the fee grant against the (existing) vault ────────────
  const pushesPerTranche = requestedPpt ?? record?.feePushesPerTranche ?? DEFAULT_FEE_PUSHES_PER_TRANCHE;
  record = {
    ...(record as LaunchOnboardingRecord),
    feeLockVault: vault,
    feePushesPerTranche: pushesPerTranche,
    status: "vault_deployed",
    ...(deployTxHash ? { deployTxHash } : {}),
  };
  await saveLaunchOnboarding(record);

  await assertOperatorIsRegistrar(publicClient, escrow, account.address);

  // A prior registration broadcast may already be in flight / landed.
  if (record.registerTxHash) {
    let receiptStatus: string | null = null;
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: record.registerTxHash as Hex });
      receiptStatus = receipt.status;
    } catch {
      receiptStatus = null;
    }
    if (receiptStatus === null) {
      throw new LaunchOnboardError(
        409,
        "LAUNCH_ONBOARD_IN_PROGRESS",
        `A fee-grant registration for ${repo} is already in flight (tx ${record.registerTxHash}) against vault ${vault} — retry shortly to collect the result.`,
        { feeLockVault: vault, resumable: true },
      );
    }
    if (receiptStatus !== "success") {
      record = { ...record, registerTxHash: undefined, lastError: `registration tx ${record.registerTxHash} reverted` };
      await saveLaunchOnboarding(record);
    }
  }

  let registerTxHash: Hex | undefined;
  try {
    registerTxHash = await walletClient.writeContract({
      address: escrow as Address,
      abi: FEE_STREAM_ESCROW_ABI,
      functionName: "registerFeeGrant",
      args: [repoIdBytes, wallet as Address, weth as Address, vault as Address, BigInt(pushesPerTranche)],
    });
    record = { ...record, registerTxHash };
    await saveLaunchOnboarding(record);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: registerTxHash });
    if (receipt.status !== "success") throw new Error(`registration tx ${registerTxHash} reverted`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record = {
      ...record,
      status: "vault_deployed",
      ...(registerTxHash ? { registerTxHash } : {}),
      lastError: message,
    };
    await saveLaunchOnboarding(record);
    console.error(
      `[launch-onboard] grant registration FAILED repo=${repo} launcher=${wallet} chain=${chain} vault=${vault} registerTx=${registerTxHash ?? "none"} error=${message}`,
    );
    throw new LaunchOnboardError(
      503,
      "LAUNCH_ONBOARD_GRANT_REGISTRATION_FAILED",
      `The FeeLockVault for ${repo} is deployed at ${vault}, but registering its fee grant failed: ${message}. The vault is recorded — retry POST /api/launch/onboard and the retry registers the grant against THIS vault; it will not deploy a second one.`,
      { feeLockVault: vault, resumable: true },
    );
  }

  const grant = await readFeeGrant(chain, repoId);
  if (!grant?.registered) {
    record = { ...record, status: "vault_deployed", lastError: "registration tx succeeded but the grant does not read back as registered" };
    await saveLaunchOnboarding(record);
    throw new LaunchOnboardError(
      503,
      "LAUNCH_ONBOARD_GRANT_REGISTRATION_FAILED",
      `Fee-grant registration for ${repo} was broadcast (tx ${registerTxHash}) but the grant does not read back as registered yet. The vault ${vault} is recorded — retry to resume.`,
      { feeLockVault: vault, resumable: true },
    );
  }
  assertGrantMatches(grant, { wallet, vault, weth, pushesPerTranche });

  record = {
    ...record,
    status: "grant_registered",
    registerTxHash,
    lastError: undefined,
  };
  await saveLaunchOnboarding(record);
  console.log(
    `[launch-onboard] grant registered repo=${repo} launcher=${wallet} chain=${chain} vault=${vault} deployTx=${record.deployTxHash ?? "pre-existing"} registerTx=${registerTxHash} pushesPerTranche=${pushesPerTranche}`,
  );
  return { alreadyOnboarded: false, record, feeGrant: grant };
}
