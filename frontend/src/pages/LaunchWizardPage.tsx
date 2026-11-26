/**
 * LaunchWizardPage — self-serve web launch flow (/launch/start).
 *
 * The website counterpart of the agent launch flow. Same backend
 * pipeline the skills/MCP drive, in the browser:
 *
 *   1. Connect GitHub (OAuth) + wallet, link wallet to the GitHub login
 *   2. Verify  — POST /api/launch/verify-github (server-side App checks;
 *      issues the 15-minute verification token bound to repo+wallet+chain)
 *   3. Configure — token name/ticker + lock terms. The platform template
 *      (25% treasury / 75% fee-lock vault, Bankr time-vesting OFF,
 *      no cancel, fees auto-lock) is FIXED — it is shown, never edited.
 *   4. Prepare — if the project has no fee-lock vault yet, POST
 *      /api/launch/onboard first (the platform deploys the vault from
 *      the approved implementation + registers its fee grant;
 *      idempotent and resumable), then POST /api/launch/prepare-launch
 *      returns the exact Bankr SDK launch input; the review screen
 *      renders THAT input.
 *   5. Launch & lock — the Bankr launch SDK (@bankr/launch-sdk)
 *      executes in the browser with the user's wallet as signer, using
 *      the prepared input verbatim (the only client-added fields are
 *      `launcher` = the signer's own address, which the SDK requires,
 *      and `launchpadId` = the platform's registered pad). Then
 *      approve + lock into GitEscrowV2, then registration.
 *   6. Status — the registered grant, consistent with the lock pages.
 *
 * Interruption recovery (BETA.md): wizard state persists in
 * sessionStorage. A completed launch with no lock lands back on the
 * lock sub-step with the same prepared record — the UI never offers a
 * relaunch. A lock with no registration lands on the register sub-step;
 * if the verification token expired in between, the wizard re-verifies
 * for a FRESH token and registers with it (never re-prepares), exactly
 * as BETA.md prescribes.
 */

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { VestingFooter } from "../components/VestingFooter";
import { CopyButton } from "../components/CopyButton";
import { useVestingAuth } from "../hooks/useVestingAuth";
import { normalizeRepoFullName, lockPathFromRepo, isValidRepoFullName } from "../lib/repoId";
import { getFrontendChainConfig } from "../lib/chains";
import { detectStreamingToken, defaultLockFunction } from "../lib/detectLockMode";
import { formatTokens } from "../lib/format";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  parseUnits,
  keccak256,
  toBytes,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { createLaunchClient, type LaunchInput } from "@bankr/launch-sdk";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const API_FETCH: RequestInit = { credentials: "include" };
const GITHUB_APP_SLUG = import.meta.env.VITE_GITHUB_APP_SLUG ?? "bankr-vesting";
const CHAIN_KEY = "base" as const;
const chainCfg = getFrontendChainConfig(CHAIN_KEY);

/** GitEscrowV2 on Base — the escrow verified launches lock into. */
const ESCROW_V2 = "0x894e36CbCD183BF5ad79Eba7B988529f0FA769c3" as Address;
/** The platform's registered Bankr launchpad (every platform launch). */
const PLATFORM_LAUNCHPAD_ID = 5n;

const ESCROW_ABI = parseAbi([
  "function lock(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile) external",
  "function lockAllowance(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile) external",
  "function encodeRepoId(string calldata ownerSlashRepo) view returns (bytes32)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type Step = 1 | 2 | 3 | 4 | 5 | 6;

type PreparedLaunch = {
  launchInput: {
    name?: string;
    symbol?: string;
    feeRecipients?: Array<{ recipient: string; shareBps: number }>;
    vesting?: { bps: number; recipient: string };
    [k: string]: unknown;
  };
  feeLockVault: string | null;
  feePushesPerTranche: number | null;
};

type WizardState = {
  step: Step;
  repo: string;
  verificationToken: string | null;
  verificationExpiresAt: string | null;
  installationId: number | null;
  name: string;
  symbol: string;
  feeLockVault: string;
  feePushesPerTranche: string;
  lockAmount: string;
  totalPushes: number;
  pushesPerMilestone: number;
  prepared: PreparedLaunch | null;
  launchedToken: string | null;
  launchTxHash: string | null;
  lockTxHash: string | null;
  registered: boolean;
  stampNote: string | null;
};

const STORAGE_KEY = "proofofdev-launch-wizard";

const INITIAL: WizardState = {
  step: 1,
  repo: "",
  verificationToken: null,
  verificationExpiresAt: null,
  installationId: null,
  name: "",
  symbol: "",
  feeLockVault: "",
  feePushesPerTranche: "",
  lockAmount: "",
  totalPushes: 20,
  pushesPerMilestone: 5,
  prepared: null,
  launchedToken: null,
  launchTxHash: null,
  lockTxHash: null,
  registered: false,
  stampNote: null,
};

function loadSaved(): WizardState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return INITIAL;
    const parsed = JSON.parse(raw) as WizardState;
    if (!parsed || typeof parsed !== "object" || !("step" in parsed)) return INITIAL;
    return { ...INITIAL, ...parsed };
  } catch {
    return INITIAL;
  }
}

/** Plain-language copy for every structured refusal the gate returns. */
function refusalMessage(code: string | undefined, fallback: string): string {
  switch (code) {
    case "LAUNCH_APP_NOT_INSTALLED":
    case "LAUNCH_APP_NO_ACCESS":
      return "The Proof of Dev GitHub App is not installed on this repo yet (or it cannot see the repo). Install it on the repo, then verify again.";
    case "LAUNCH_NOT_OWNER_OR_ADMIN":
      return "Your GitHub login does not own this repo and is not an admin on it. Verify with a repo you own, or have an owner add you as an admin.";
    case "LAUNCH_WALLET_NOT_LINKED":
      return "This wallet is not linked to your GitHub login yet. Go back to Step 1 and link it — the link is a signature, it never moves funds.";
    case "LAUNCH_TOKEN_EXPIRED":
      return "Your verification expired — verification tokens last 15 minutes. Verify again to get a fresh one; your configuration and prepared launch do not change.";
    case "LAUNCH_TOKEN_MALFORMED":
    case "LAUNCH_TOKEN_BAD_SIGNATURE":
      return "That verification token is not valid for this repo and wallet. Verify again to get a fresh one.";
    case "LAUNCH_FEE_VAULT_REQUIRED":
      return "Prepare-launch needs your project's fee-lock vault, and none is known yet. The wizard normally onboards you automatically at Prepare (the platform deploys the vault and registers its fee grant) — if you are seeing this, onboarding did not run or did not finish. Go back to Prepare and try again; do not launch outside the platform in the meantime: an outside launch gets no verified recognition.";
    case "LAUNCH_FEE_GRANT_NOT_REGISTERED":
      return "Your fee-lock vault exists, but the matching fee grant is not registered on the fee escrow yet. The wizard retries onboarding automatically — the platform registrar registers the grant against your existing vault (never a second one). If this persists, press Prepare again.";
    case "LAUNCH_ONBOARD_GRANT_REGISTRATION_FAILED":
      return "Onboarding deployed your fee-lock vault but the fee-grant registration did not finish. Nothing is lost and no second vault will be deployed: press Prepare again and onboarding resumes against the same vault until the grant is registered.";
    case "LAUNCH_ONBOARD_IN_PROGRESS":
      return "Onboarding for this project is already in flight (a vault deployment or grant registration is landing on-chain). Wait a few seconds, then press Prepare again — the retry collects the result.";
    case "LAUNCH_ONBOARD_NOT_CONFIGURED":
    case "LAUNCH_ONBOARD_SIGNER_NOT_REGISTRAR":
      return "Launch onboarding is not configured on the platform server right now, so no vault can be deployed. This is a platform-side setting, not something you can fix from here.";
    case "LAUNCH_FEE_VAULT_IS_LAUNCHER_WALLET":
      return "The fee-lock vault cannot be your own wallet — the launcher share must land in the vault contract so fees auto-lock instead of arriving liquid.";
    case "LAUNCH_FEE_VAULT_NOT_A_CONTRACT":
      return "That fee-lock vault address has no contract code on Base. Check the address the platform gave you.";
    case "LAUNCH_VAULT_NOT_APPROVED_IMPL":
      return "That vault is not an instance of the platform's approved fee-lock vault implementation, so it cannot receive a launcher fee share.";
    case "PLATFORM_TREASURY_NOT_CONFIGURED":
      return "The platform reward treasury is not configured on the server, so no launch can be prepared right now. This is a platform-side setting, not something you can fix from here.";
    default:
      return fallback;
  }
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) return `${err.message} ${cause.message}`;
    return err.message;
  }
  return String(err);
}

async function waitForTxConfirmation(
  hash: Hash,
  publicClient: PublicClient,
  label: string,
  timeoutMs = 120_000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tx = await publicClient.getTransaction({ hash }).catch(() => null);
    if (tx) {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: Math.max(15_000, timeoutMs - (Date.now() - start)),
      });
      if (receipt.status !== "success") {
        throw new Error(`${label} reverted on-chain. See ${chainCfg.explorerBase}/tx/${hash}`);
      }
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`${label} never appeared on Base (${chainCfg.explorerBase}/tx/${hash}).`);
}

type GrantStatus = {
  status?: string;
  totalLocked?: string;
  verifiedPushCount?: number;
  totalPushesRequired?: number;
  tokensPerMilestone?: string;
  launchVerified?: boolean;
};

export function LaunchWizardPage() {
  const navigate = useNavigate();
  const { wallet, githubUser, connectWallet, connectGitHub } = useVestingAuth();
  const [state, setState] = useState<WizardState>(loadSaved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [linkedWallets, setLinkedWallets] = useState<string[] | null>(null);
  const [myRepos, setMyRepos] = useState<string[]>([]);
  const [installCheck, setInstallCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [tokenDecimals, setTokenDecimals] = useState(18);
  const [grantStatus, setGrantStatus] = useState<GrantStatus | null>(null);
  const didResumeNotice = useRef(false);
  const [resumed, setResumed] = useState(false);

  const step = state.step;
  const repo = normalizeRepoFullName(state.repo);
  const walletLinked = Boolean(
    wallet && linkedWallets?.some((w) => w.toLowerCase() === wallet.toLowerCase()),
  );
  const tokenExpired = Boolean(
    state.verificationExpiresAt && new Date(state.verificationExpiresAt).getTime() < Date.now(),
  );

  function patch(p: Partial<WizardState>) {
    setState((s) => ({ ...s, ...p }));
  }

  // Persist for interruption recovery (refresh, OAuth bounce, closed tab).
  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  // Resume notice: arriving with a launch already broadcast changes the
  // whole meaning of step 5 — say so once, loudly.
  useEffect(() => {
    if (didResumeNotice.current) return;
    if (state.launchedToken && !state.registered) {
      didResumeNotice.current = true;
      setResumed(true);
    }
  }, [state.launchedToken, state.registered]);

  // Linked wallets for the connected GitHub login.
  useEffect(() => {
    if (!githubUser) {
      setLinkedWallets(null);
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/dev/link-wallet/${githubUser.login}`, API_FETCH);
        const d = (await res.json()) as { wallets?: Array<{ wallet?: string } | string> };
        const list = (d.wallets ?? [])
          .map((w) => (typeof w === "string" ? w : w.wallet))
          .filter(Boolean) as string[];
        setLinkedWallets(list);
      } catch {
        setLinkedWallets([]);
      }
    })();
  }, [githubUser]);

  // Repo picker from the GitHub session.
  useEffect(() => {
    if (!githubUser) {
      setMyRepos([]);
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/github/repos`, API_FETCH);
        if (!res.ok) return;
        const data = (await res.json()) as { repos?: Array<{ fullName?: string }> };
        setMyRepos((data.repos ?? []).map((r) => r.fullName).filter(Boolean) as string[]);
      } catch { /* ignore */ }
    })();
  }, [githubUser]);

  // App installation check for the chosen repo.
  useEffect(() => {
    if (!isValidRepoFullName(repo)) {
      setInstallCheck(null);
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/github/installation?repo=${encodeURIComponent(repo)}`);
        const d = (await res.json()) as { ok: boolean; error?: string; hint?: string };
        setInstallCheck({
          ok: d.ok,
          message: d.ok
            ? `GitHub App can access ${repo}`
            : [d.error, d.hint].filter(Boolean).join(" — ") || "GitHub App cannot access this repo yet",
        });
      } catch {
        setInstallCheck({ ok: false, message: "Could not verify GitHub App access" });
      }
    })();
  }, [repo]);

  // Token decimals once launched (needed to size the lock).
  useEffect(() => {
    if (!state.launchedToken) return;
    void (async () => {
      try {
        const client = createPublicClient({ chain: chainCfg.chain, transport: http(chainCfg.rpcUrl) });
        const dec = await client.readContract({
          address: state.launchedToken as Address,
          abi: ERC20_ABI,
          functionName: "decimals",
        });
        setTokenDecimals(Number(dec));
      } catch { /* default 18 */ }
    })();
  }, [state.launchedToken]);

  // Grant status on the final step.
  useEffect(() => {
    if (step !== 6 || !isValidRepoFullName(repo)) return;
    const [owner, repoName] = repo.split("/");
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/vesting/lock/${owner}/${repoName}`);
        if (!res.ok) return;
        const d = (await res.json()) as { grant?: GrantStatus } & GrantStatus;
        setGrantStatus(d.grant ?? d);
      } catch { /* the lock page link below still works */ }
    })();
  }, [step, repo]);

  async function handleLinkWallet() {
    if (!wallet || !githubUser) return;
    const provider = (window as Window & { ethereum?: EthereumProvider }).ethereum;
    if (!provider) {
      setError("No wallet detected. Install MetaMask or Coinbase Wallet.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const chRes = await fetch(`${API_BASE}/api/dev/link-wallet/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wallet-address": wallet },
        body: JSON.stringify({ wallet }),
        ...API_FETCH,
      });
      const ch = (await chRes.json()) as { ok?: boolean; signMessage?: string; error?: string };
      if (!ch.ok || !ch.signMessage) throw new Error(ch.error ?? "Link challenge failed");
      const signature = (await provider.request({
        method: "personal_sign",
        params: [ch.signMessage, wallet],
      })) as string;
      const cfRes = await fetch(`${API_BASE}/api/dev/link-wallet/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wallet-address": wallet },
        body: JSON.stringify({ wallet, signature, signMessage: ch.signMessage }),
        ...API_FETCH,
      });
      const cf = (await cfRes.json()) as { ok?: boolean; error?: string; wallets?: Array<{ wallet?: string }> };
      if (!cf.ok) throw new Error(cf.error ?? "Link failed");
      setLinkedWallets((cf.wallets ?? []).map((w) => w.wallet).filter(Boolean) as string[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet link failed");
    } finally {
      setBusy(false);
    }
  }

  async function runVerify(): Promise<{ token: string; expiresAt: string } | null> {
    if (!githubUser || !wallet || !isValidRepoFullName(repo)) return null;
    const res = await fetch(`${API_BASE}/api/launch/verify-github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubLogin: githubUser.login, repo, wallet, chain: CHAIN_KEY }),
      ...API_FETCH,
    });
    const d = (await res.json()) as {
      ok?: boolean;
      verificationToken?: string;
      expiresAt?: string;
      installationId?: number;
      code?: string;
      error?: string;
    };
    if (!d.ok || !d.verificationToken) {
      throw Object.assign(new Error(refusalMessage(d.code, d.error ?? "Verification failed")), {
        code: d.code,
      });
    }
    const out = { token: d.verificationToken, expiresAt: d.expiresAt ?? "" };
    patch({
      verificationToken: out.token,
      verificationExpiresAt: out.expiresAt,
      installationId: d.installationId ?? state.installationId,
    });
    return out;
  }

  async function handleVerify() {
    setBusy(true);
    setError(null);
    try {
      const v = await runVerify();
      if (v) patch({ step: 3 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Platform onboarding (POST /api/launch/onboard): the platform
   * deploys this project's fee-lock vault from the approved
   * implementation and registers its fee grant — the two operator
   * actions prepare-launch requires to already exist. Idempotent and
   * resumable server-side: repeat calls return the same vault, and a
   * retry after a failed grant registration completes against the
   * existing vault. Returns the vault address.
   */
  async function runOnboard(token: string): Promise<string> {
    const ppt = state.feePushesPerTranche.trim();
    const res = await fetch(`${API_BASE}/api/launch/onboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wallet-address": wallet ?? "" },
      body: JSON.stringify({
        repo,
        wallet,
        chain: CHAIN_KEY,
        verificationToken: token,
        ...(ppt ? { feePushesPerTranche: Number(ppt) } : {}),
      }),
      ...API_FETCH,
    });
    const d = (await res.json()) as {
      ok?: boolean;
      code?: string;
      error?: string;
      feeLockVault?: string;
      feeGrant?: { pushesPerTranche?: number };
    };
    if (!d.ok || !d.feeLockVault) {
      throw Object.assign(new Error(refusalMessage(d.code, d.error ?? "Onboarding failed")), {
        code: d.code,
      });
    }
    patch({
      feeLockVault: d.feeLockVault,
      ...(d.feeGrant?.pushesPerTranche
        ? { feePushesPerTranche: String(d.feeGrant.pushesPerTranche) }
        : {}),
    });
    return d.feeLockVault;
  }

  async function handlePrepare() {
    if (!state.verificationToken) {
      setError("Verify first (Step 2) — prepare-launch requires a verification token.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Onboard first when no vault is known: the platform deploys
      // the fee-lock vault + registers the fee grant, then prepare
      // validates them. A vault the user pasted (recovery path) is
      // used as-is; if prepare then reports its grant missing, one
      // onboarding resume + one retry closes that gap too.
      let vault = state.feeLockVault.trim();
      if (!vault) {
        setTxStatus("Onboarding: the platform is deploying your fee-lock vault and registering its fee grant…");
        vault = await runOnboard(state.verificationToken);
        setTxStatus(null);
      }
      const ppt = state.feePushesPerTranche.trim();
      const callPrepare = (vaultAddr: string) =>
        fetch(`${API_BASE}/api/launch/prepare-launch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-wallet-address": wallet ?? "" },
          body: JSON.stringify({
            repo,
            wallet,
            chain: CHAIN_KEY,
            verificationToken: state.verificationToken,
            feeLockVault: vaultAddr,
            ...(ppt ? { feePushesPerTranche: Number(ppt) } : {}),
            launch: { name: state.name.trim(), symbol: state.symbol.trim().toUpperCase() },
          }),
          ...API_FETCH,
        });
      let res = await callPrepare(vault);
      let d = (await res.json()) as {
        ok?: boolean;
        code?: string;
        error?: string;
        launchInput?: PreparedLaunch["launchInput"];
        feeLockVault?: string | null;
        feePushesPerTranche?: number;
      };
      if (!d.ok && d.code === "LAUNCH_FEE_GRANT_NOT_REGISTERED") {
        setTxStatus("Onboarding: registering the fee grant against your vault…");
        vault = await runOnboard(state.verificationToken);
        setTxStatus(null);
        res = await callPrepare(vault);
        d = (await res.json()) as typeof d;
      }
      if (!d.ok || !d.launchInput) {
        if (d.code === "LAUNCH_TOKEN_EXPIRED") {
          patch({ step: 2 });
        }
        throw new Error(refusalMessage(d.code, d.error ?? "Prepare failed"));
      }
      patch({
        prepared: {
          launchInput: d.launchInput,
          feeLockVault: d.feeLockVault ?? (state.feeLockVault.trim() || null),
          feePushesPerTranche: d.feePushesPerTranche ?? (ppt ? Number(ppt) : null),
        },
        step: 5,
      });
    } catch (e) {
      if ((e as { code?: string })?.code === "LAUNCH_TOKEN_EXPIRED") {
        patch({ step: 2 });
      }
      setError(e instanceof Error ? e.message : "Prepare failed");
    } finally {
      setBusy(false);
      setTxStatus(null);
    }
  }

  async function handleLaunch() {
    if (!wallet || !state.prepared) return;
    const provider = (window as Window & { ethereum?: EthereumProvider }).ethereum;
    if (!provider) {
      setError("No wallet detected. Install MetaMask or Coinbase Wallet.");
      return;
    }
    setBusy(true);
    setError(null);
    setTxStatus(null);
    try {
      const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
      if (Number.parseInt(chainIdHex, 16) !== chainCfg.chain.id) {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: `0x${chainCfg.chain.id.toString(16)}` }],
        });
      }
      const publicClient = createPublicClient({ chain: chainCfg.chain, transport: http(chainCfg.rpcUrl) });
      const walletClient = createWalletClient({
        chain: chainCfg.chain,
        transport: custom(provider),
        account: wallet,
      });
      const client = createLaunchClient({
        chain: "base",
        publicClient,
        walletClient: walletClient as unknown as WalletClient,
      });

      // The prepared input is the source of truth for every economic
      // parameter. The SDK additionally requires `launcher` (the
      // signer's own address) and the platform's launchpad id — both
      // are identity constants of this surface, not launch parameters.
      const preparedInput = state.prepared.launchInput as Record<string, unknown>;
      const baseInput: Record<string, unknown> = {
        ...preparedInput,
        launcher: wallet,
        launchpadId: PLATFORM_LAUNCHPAD_ID,
      };

      setTxStatus("Checking the launch against the Bankr pad (plan)…");
      let planError: unknown = null;
      try {
        await client.plan(baseInput as unknown as LaunchInput<"base">);
      } catch (e) {
        planError = e;
      }
      let input = baseInput;
      if (planError) {
        // The launcher share lands in a contract (the fee-lock vault).
        // If the pad refuses an unproven contract recipient at plan
        // time, retry once with the SDK's explicit contract-recipient
        // allowance — the vault is claim-capable by design.
        if (/contract|recipient/i.test(extractErrorMessage(planError))) {
          input = { ...baseInput, allowContractFeeRecipient: true };
          await client.plan(input as unknown as LaunchInput<"base">);
        } else {
          throw planError;
        }
      }

      setTxStatus("Confirm the launch in your wallet — this creates the token…");
      const result = (await client.launch(input as unknown as LaunchInput<"base">)) as unknown as {
        token: string;
        txHash: string;
      };
      patch({ launchedToken: result.token, launchTxHash: result.txHash });
      setTxStatus(null);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
      setTxStatus(null);
    }
  }

  async function handleLock() {
    if (!wallet || !state.launchedToken) return;
    const provider = (window as Window & { ethereum?: EthereumProvider }).ethereum;
    if (!provider) {
      setError("No wallet detected. Install MetaMask or Coinbase Wallet.");
      return;
    }
    setBusy(true);
    setError(null);
    setTxStatus(null);
    try {
      const readClient = createPublicClient({ chain: chainCfg.chain, transport: http(chainCfg.rpcUrl) });
      const walletClient = createWalletClient({
        chain: chainCfg.chain,
        transport: custom(provider),
        account: wallet,
      });
      const tokenAddr = state.launchedToken as Address;
      const amount = parseUnits(state.lockAmount, tokenDecimals);
      const repoId = keccak256(toBytes(repo));
      const lockArgs = [
        repoId,
        tokenAddr,
        amount,
        BigInt(state.totalPushes),
        BigInt(state.pushesPerMilestone),
      ] as const;

      const allowance = await readClient.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [wallet, ESCROW_V2],
      });
      if (allowance < amount) {
        setTxStatus(`Confirm approve in your wallet — spender is GitEscrowV2 (${ESCROW_V2}), amount is exactly your lock size…`);
        const approveTx = await walletClient.writeContract({
          address: tokenAddr,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [ESCROW_V2, amount],
        });
        await waitForTxConfirmation(approveTx, readClient, "Approve");
      }

      const streaming = await detectStreamingToken(tokenAddr, CHAIN_KEY, wallet, ESCROW_V2);
      let lockFn: "lock" | "lockAllowance" = streaming ? "lockAllowance" : defaultLockFunction(CHAIN_KEY);
      try {
        await readClient.simulateContract({
          address: ESCROW_V2,
          abi: ESCROW_ABI,
          functionName: lockFn,
          args: lockArgs,
          account: wallet,
        });
      } catch (simErr) {
        const msg = extractErrorMessage(simErr);
        if (lockFn === "lock" && /pull failed|lockAllowance|restricted/i.test(msg)) {
          lockFn = "lockAllowance";
          await readClient.simulateContract({
            address: ESCROW_V2,
            abi: ESCROW_ABI,
            functionName: lockFn,
            args: lockArgs,
            account: wallet,
          });
        } else {
          throw simErr;
        }
      }

      setTxStatus("Confirm the lock in your wallet — this moves the supply into the no-cancel escrow…");
      const lockTx = await walletClient.writeContract({
        address: ESCROW_V2,
        abi: ESCROW_ABI,
        functionName: lockFn,
        args: lockArgs,
      });
      await waitForTxConfirmation(lockTx, readClient, "Lock");
      patch({ lockTxHash: lockTx });
      setTxStatus(null);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
      setTxStatus(null);
    }
  }

  async function handleRegister() {
    if (!wallet || !state.launchedToken || !state.lockTxHash) return;
    setBusy(true);
    setError(null);
    try {
      // Fresh-token rule (BETA.md): if the verification token expired
      // after the lock, re-verify and register with the FRESH token.
      // Never re-prepare — registration binds to the original record.
      let token = state.verificationToken;
      if (!token || tokenExpired) {
        const v = await runVerify();
        if (!v) throw new Error("Re-verification failed — reconnect GitHub and wallet, then finish registration.");
        token = v.token;
      }
      const milestones = state.totalPushes / state.pushesPerMilestone;
      const lockAmountWei = parseUnits(state.lockAmount, tokenDecimals);
      const tokensPerMilestone = (lockAmountWei / BigInt(milestones)).toString();
      const streaming = await detectStreamingToken(
        state.launchedToken as Address,
        CHAIN_KEY,
        wallet,
        ESCROW_V2,
      ).catch(() => false);
      const res = await fetch(`${API_BASE}/api/vesting/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoFullName: repo,
          platform: "github",
          recipient: wallet,
          token: state.launchedToken,
          chain: CHAIN_KEY,
          totalLocked: lockAmountWei.toString(),
          totalPushesRequired: state.totalPushes,
          pushesPerMilestone: state.pushesPerMilestone,
          tokensPerMilestone,
          onChainTxHash: state.lockTxHash,
          installationId: state.installationId ?? 0,
          streaming,
          launchVerificationToken: token,
          ...(state.prepared?.feeLockVault ? { feeLockVault: state.prepared.feeLockVault } : {}),
          ...(state.prepared?.feePushesPerTranche
            ? { feePushesPerTranche: state.prepared.feePushesPerTranche }
            : {}),
        }),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        error?: string;
        launchVerification?: { stamped?: boolean; note?: string; code?: string };
      };
      if (!d.ok && res.status !== 409) {
        throw new Error(d.error ?? "Registration failed");
      }
      const note =
        d.launchVerification && d.launchVerification.stamped === false
          ? (d.launchVerification.note ?? "The grant registered, but the verified-launch stamp was withheld — see the platform's recognition rules.")
          : null;
      patch({ registered: true, stampNote: note, step: 6 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    sessionStorage.removeItem(STORAGE_KEY);
    setState(INITIAL);
    setGrantStatus(null);
    setResumed(false);
    didResumeNotice.current = false;
  }

  const milestonesCount =
    state.totalPushes > 0 && state.pushesPerMilestone > 0
      ? state.totalPushes / state.pushesPerMilestone
      : 0;
  const preparedRecipients = state.prepared?.launchInput.feeRecipients ?? [];
  const installUrl = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;

  return (
    <div className="vesting-page vesting-page--wide">
      <VestingNav />
      <header>
        <h1>Launch a token</h1>
        <p className="muted">
          Step {step} of 6 · Base · Beta — the same verified launch pipeline the agent skills
          run, in your browser. You sign everything from your own wallet; the platform never
          takes custody.
        </p>
      </header>

      <ol className="launch-wiz-steps" aria-label="Launch progress">
        {["Connect", "Verify", "Configure", "Prepare", "Launch & lock", "Status"].map((label, i) => (
          <li key={label} className={step === i + 1 ? "active" : step > i + 1 ? "done" : ""}>
            {label}
          </li>
        ))}
      </ol>

      {error && (
        <p className="err" style={{ whiteSpace: "pre-wrap", marginBottom: "1rem" }}>{error}</p>
      )}

      {resumed && !state.registered && (
        <div className="launch-wiz-resume" role="status">
          <strong>Welcome back — your launch already happened.</strong> Your token{" "}
          <code>{state.launchedToken}</code> is live and safe in your wallet.{" "}
          <strong>Do NOT launch again</strong> — a second launch creates a second token and
          cannot earn this launch's verified stamp. Pick up at the lock step below; the wizard
          kept your prepared record.
        </div>
      )}

      {step === 1 && (
        <section className="vesting-card setup-card">
          <h2>Connect GitHub & wallet</h2>
          {!githubUser ? (
            <p>
              <button type="button" className="btn btn-primary" onClick={() => connectGitHub()}>
                Connect GitHub
              </button>
            </p>
          ) : (
            <p className="muted">GitHub: <strong>@{githubUser.login}</strong></p>
          )}
          {!wallet ? (
            <p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void connectWallet().catch((e: unknown) => setError(e instanceof Error ? e.message : "Wallet connect failed"))}
              >
                Connect wallet
              </button>
            </p>
          ) : (
            <p className="muted">Wallet: <code>{wallet.slice(0, 6)}…{wallet.slice(-4)}</code></p>
          )}
          {githubUser && wallet && (
            walletLinked ? (
              <p className="field-hint ok">✓ Wallet linked to @{githubUser.login}</p>
            ) : (
              <>
                <p className="muted">
                  Verification requires this wallet to be linked to your GitHub login. The link
                  is a signature — it proves the binding and never moves funds.
                </p>
                <button type="button" className="btn" onClick={() => void handleLinkWallet()} disabled={busy}>
                  {busy ? "Signing…" : "Link wallet to GitHub"}
                </button>
              </>
            )
          )}
          <p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!githubUser || !wallet || !walletLinked}
              onClick={() => patch({ step: 2 })}
            >
              Next →
            </button>
          </p>
        </section>
      )}

      {step === 2 && (
        <section className="vesting-card setup-card">
          <button type="button" className="btn btn-ghost" onClick={() => patch({ step: 1 })}>← Back</button>
          <h2>Verify your repo</h2>
          <label>
            GitHub repo
            <input
              type="text"
              placeholder="owner/repo"
              list={myRepos.length ? "launch-wiz-repos" : undefined}
              value={state.repo}
              onChange={(e) => patch({ repo: e.target.value, verificationToken: null, prepared: null })}
            />
            {myRepos.length > 0 && (
              <datalist id="launch-wiz-repos">
                {myRepos.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            )}
          </label>
          {installCheck && (
            <p className={installCheck.ok ? "field-hint ok" : "field-hint err"}>{installCheck.message}</p>
          )}
          <p>
            <a href={installUrl} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
              Install the GitHub App on your repo →
            </a>
          </p>
          <p className="muted">
            Verification is server-side: the App must be installed on the repo, your login must
            own it or admin it, and your wallet must be linked. On success you get a verification
            token bound to this repo, wallet, and chain for 15 minutes — it carries through
            prepare, lock, and registration.
          </p>
          {state.verificationToken && !tokenExpired && (
            <p className="field-hint ok">
              ✓ Verified — token valid until {state.verificationExpiresAt ? new Date(state.verificationExpiresAt).toLocaleTimeString() : "soon"}
            </p>
          )}
          {state.verificationToken && tokenExpired && (
            <p className="field-hint err">Verification expired — verify again to get a fresh token.</p>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !isValidRepoFullName(repo)}
            onClick={() => void handleVerify()}
          >
            {busy ? "Verifying…" : state.verificationToken ? "Re-verify" : "Verify repo"}
          </button>
        </section>
      )}

      {step === 3 && (
        <section className="vesting-card setup-card">
          <button type="button" className="btn btn-ghost" onClick={() => patch({ step: 2 })}>← Back</button>
          <h2>Configure your token</h2>
          <div className="create-grid">
            <label>
              Token name
              <input
                type="text"
                maxLength={100}
                placeholder="e.g. My Project"
                value={state.name}
                onChange={(e) => patch({ name: e.target.value, prepared: null })}
              />
            </label>
            <label>
              Ticker
              <input
                type="text"
                maxLength={20}
                placeholder="e.g. PROJ"
                value={state.symbol}
                onChange={(e) => patch({ symbol: e.target.value.toUpperCase(), prepared: null })}
              />
            </label>
          </div>
          <div className="create-grid">
            <label>
              Supply to lock (tokens)
              <input
                type="number"
                min="0"
                placeholder="e.g. 200000000"
                value={state.lockAmount}
                onChange={(e) => patch({ lockAmount: e.target.value })}
              />
            </label>
            <label>
              Verified pushes required
              <input
                type="number"
                min="1"
                value={state.totalPushes}
                onChange={(e) => patch({ totalPushes: Number(e.target.value) })}
              />
            </label>
            <label>
              Release every N pushes
              <input
                type="number"
                min="1"
                value={state.pushesPerMilestone}
                onChange={(e) => patch({ pushesPerMilestone: Number(e.target.value) })}
              />
            </label>
          </div>
          {milestonesCount > 0 && state.lockAmount && (
            <p className="schedule-preview">
              {milestonesCount} milestone{milestonesCount === 1 ? "" : "s"}: every{" "}
              {state.pushesPerMilestone} verified pushes release{" "}
              {(parseFloat(state.lockAmount) / milestonesCount).toLocaleString()} {state.symbol || "tokens"}.
            </p>
          )}
          <label>
            Fee-lock vault address (optional — the platform deploys it for you)
            <input
              type="text"
              placeholder="Leave blank — deployed automatically at Prepare"
              value={state.feeLockVault}
              onChange={(e) => patch({ feeLockVault: e.target.value, prepared: null })}
            />
            <span className="field-hint">
              At Prepare, the platform automatically deploys this per-project vault from its
              approved implementation and registers its fee grant, then fills this in. Only
              paste an address here if the platform gave you one for a project already
              onboarded (for example, recovering an interrupted launch).
            </span>
          </label>
          <label>
            Fee tranche schedule — pushes per tranche (optional)
            <input
              type="number"
              min="1"
              placeholder="Leave blank to match the registered grant"
              value={state.feePushesPerTranche}
              onChange={(e) => patch({ feePushesPerTranche: e.target.value, prepared: null })}
            />
          </label>

          <h3>The platform template — fixed on every launch</h3>
          <div className="launch-guarantees">
            <article className="vesting-card launch-guarantee">
              <h3>25 / 75 fee split</h3>
              <p>Of the creator slice of every trading fee, 25% goes to the platform reward treasury and 75% to your project's fee-lock vault. Never to a raw wallet.</p>
            </article>
            <article className="vesting-card launch-guarantee">
              <h3>Time-vesting is off</h3>
              <p>Bankr time-vesting is set to zero, explicitly. Unlocking is by verified pushes, never by calendar.</p>
            </article>
            <article className="vesting-card launch-guarantee">
              <h3>No cancel, no exit</h3>
              <p>The escrow has no cancel function. Tokens leave only as counted pushes land against the schedule fixed at lock time.</p>
            </article>
            <article className="vesting-card launch-guarantee">
              <h3>Your trading fees lock too</h3>
              <p>Your 75% fee share lands in the fee-lock vault and vests over subsequent counted pushes — it never arrives liquid.</p>
            </article>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            disabled={
              !state.name.trim() ||
              !state.symbol.trim() ||
              !state.lockAmount ||
              !(parseFloat(state.lockAmount) > 0) ||
              state.totalPushes < 1 ||
              state.pushesPerMilestone < 1 ||
              state.totalPushes % state.pushesPerMilestone !== 0
            }
            onClick={() => patch({ step: 4 })}
          >
            Review the template & prepare →
          </button>
        </section>
      )}

      {step === 4 && (
        <section className="vesting-card setup-card">
          <button type="button" className="btn btn-ghost" onClick={() => patch({ step: 3 })}>← Back</button>
          <h2>Prepare the launch</h2>
          <p className="muted">
            If your project is not onboarded yet, this step onboards it first: the platform
            deploys your fee-lock vault and registers its fee grant (platform transactions,
            not yours — nothing for you to sign). Prepare-launch then re-reads the vault's
            bindings on-chain and confirms the registered fee grant before it hands out
            anything signable.
          </p>
          {txStatus && <p className="muted">{txStatus}</p>}
          {tokenExpired && (
            <p className="field-hint err">
              Your verification token has expired. <button type="button" className="btn btn-ghost btn-sm" onClick={() => patch({ step: 2 })}>Re-verify</button> — your configuration is kept.
            </p>
          )}
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handlePrepare()}>
            {busy ? "Preparing…" : "Prepare launch"}
          </button>
        </section>
      )}

      {step === 5 && state.prepared && (
        <section className="vesting-card setup-card">
          <h2>Review, launch & lock</h2>
          <div className="vesting-summary">
            <p><strong>Token:</strong> {state.prepared.launchInput.name} ({state.prepared.launchInput.symbol})</p>
            <p><strong>Repo:</strong> {repo}</p>
            <p><strong>Pair:</strong> WETH — the Bankr pad's default quote on Base (the prepared input names no other quote)</p>
            <p><strong>Fee recipients (creator slice):</strong></p>
            <ul>
              {preparedRecipients.map((r) => (
                <li key={r.recipient}>
                  <code>{r.recipient}</code> — {(r.shareBps / 100).toFixed(0)}%
                  {state.prepared?.feeLockVault && r.recipient.toLowerCase() === state.prepared.feeLockVault.toLowerCase()
                    ? " (your fee-lock vault — fees auto-lock)"
                    : r.shareBps === 2500
                      ? " (platform reward treasury)"
                      : ""}
                </li>
              ))}
            </ul>
            <p><strong>Bankr time-vesting:</strong> OFF — explicitly {state.prepared.launchInput.vesting?.bps ?? 0} bps</p>
            <p><strong>Lock:</strong> {state.lockAmount} {state.symbol} into GitEscrowV2 <code>{ESCROW_V2}</code>, releasing every {state.pushesPerMilestone} of {state.totalPushes} verified pushes</p>
          </div>

          {!state.launchedToken && (
            <>
              {txStatus && <p className="muted">{txStatus}</p>}
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handleLaunch()}>
                {busy ? "Working…" : `Launch ${state.symbol || "token"} (sign in wallet)`}
              </button>
              <p className="muted">
                The launch executes through the Bankr launch SDK in your browser, from your
                wallet, on the platform's launchpad — with exactly the prepared input above.
              </p>
            </>
          )}

          {state.launchedToken && (
            <>
              <p className="field-hint ok">
                ✓ Launched: <code>{state.launchedToken}</code>{" "}
                <a href={`${chainCfg.explorerBase}/tx/${state.launchTxHash}`} target="_blank" rel="noreferrer">launch tx</a>
              </p>
              {!state.lockTxHash && (
                <>
                  <div className="launch-wiz-resume" role="status">
                    <strong>Your token is live — now lock the supply.</strong> Do NOT launch
                    again: a second launch creates a second token. If you close this page, this
                    step will be waiting when you come back, with the same prepared record.
                  </div>
                  {txStatus && <p className="muted">{txStatus}</p>}
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handleLock()}>
                    {busy ? "Working…" : `Approve & lock ${state.lockAmount} ${state.symbol}`}
                  </button>
                  <p className="muted">
                    You will sign an approve (only if asked — check the spender is GitEscrowV2{" "}
                    <code>{ESCROW_V2}</code> and the amount matches your lock size) and then the
                    lock transaction itself.
                  </p>
                </>
              )}
            </>
          )}

          {state.lockTxHash && !state.registered && (
            <>
              <p className="field-hint ok">
                ✓ Locked: <a href={`${chainCfg.explorerBase}/tx/${state.lockTxHash}`} target="_blank" rel="noreferrer">lock tx</a>
              </p>
              <p className="muted">
                Last step: registration. No funds move — the platform verifies the evidence
                chain (prepared record, ordering, lock event, vault bindings, fee recipients)
                and stamps your grant as a verified launch. If your verification token expired
                since the lock, the wizard re-verifies and registers with the fresh token —
                it never re-prepares and never relaunches.
              </p>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handleRegister()}>
                {busy ? "Registering…" : "Finish registration"}
              </button>
            </>
          )}
        </section>
      )}

      {step === 6 && (
        <section className="vesting-card setup-card">
          <h2>Your verified launch is live</h2>
          {state.stampNote ? (
            <p className="err" style={{ whiteSpace: "pre-wrap" }}>{state.stampNote}</p>
          ) : (
            <p className="field-hint ok">✓ Grant registered and stamped as a verified launch.</p>
          )}
          <div className="vesting-summary">
            <p><strong>Token:</strong> {state.symbol} — <code>{state.launchedToken}</code></p>
            <p><strong>Repo:</strong> {repo}</p>
            {grantStatus ? (
              <>
                <p><strong>Status:</strong> {grantStatus.status ?? "active"}</p>
                <p>
                  <strong>Locked:</strong>{" "}
                  {grantStatus.totalLocked ? formatTokens(grantStatus.totalLocked) : state.lockAmount} {state.symbol}
                </p>
                <p>
                  <strong>Pushes counted:</strong> {grantStatus.verifiedPushCount ?? 0} /{" "}
                  {grantStatus.totalPushesRequired ?? state.totalPushes} — next release at{" "}
                  {state.pushesPerMilestone} counted pushes
                </p>
              </>
            ) : (
              <p><strong>Locked:</strong> {state.lockAmount} {state.symbol} · 0 / {state.totalPushes} pushes counted</p>
            )}
          </div>
          <p>
            <Link to={lockPathFromRepo(repo)} className="btn btn-primary">
              View your lock & push progress →
            </Link>{" "}
            <button type="button" className="btn btn-ghost" onClick={startOver}>
              Start a new launch
            </button>
          </p>
          <p className="muted">
            Ship real code to <code>{repo}</code>'s production branch — counted pushes unlock
            your supply and your fee tranches on the schedule above.
          </p>
        </section>
      )}

      <VestingFooter />
    </div>
  );
}
