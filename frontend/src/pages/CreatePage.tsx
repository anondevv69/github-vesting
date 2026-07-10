/**
 * VestingSetupPage — Multi-step wizard for setting up GitHub-gated token vesting.
 *
 * Steps:
 *   1. Connect wallet (fee recipient)
 *   2. Connect GitHub OAuth
 *   3. Enter repo + token details
 *   4. Configure vesting schedule (total pushes, release interval)
 *   5. Approve + Lock tokens on-chain
 *   6. Confirm GitHub App installation
 */

import { useState, useEffect, useRef } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { VestingFooter } from "../components/VestingFooter";
import { VestingPathChart } from "../components/VestingPathChart";
import { CopyButton } from "../components/CopyButton";
import { useVestingAuth } from "../hooks/useVestingAuth";
import { normalizeRepoFullName, lockPathFromRepo, isValidRepoFullName } from "../lib/repoId";
import { buildRepoClaimAgentPrompt } from "../lib/repoClaimPrompt";
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
} from "viem";
import {
  getFrontendChainConfig,
  resolveCreatePageChain,
  type FrontendChainConfig,
  type VestingChainKey,
} from "../lib/chains";
import { detectStreamingToken, defaultLockFunction } from "../lib/detectLockMode";

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) return `${err.message} ${cause.message}`;
    if (typeof cause === "object" && cause && "reason" in cause) {
      return `${err.message} ${String((cause as { reason?: string }).reason ?? "")}`;
    }
    return err.message;
  }
  return String(err);
}

async function ensureWalletChain(provider: EthereumProvider, chainCfg: FrontendChainConfig) {
  const chainIdHex = `0x${chainCfg.chain.id.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (err: unknown) {
    const e = err as { code?: number };
    if (e?.code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: chainIdHex,
        chainName: chainCfg.chain.name,
        nativeCurrency: chainCfg.chain.nativeCurrency,
        rpcUrls: [chainCfg.rpcUrl],
        blockExplorerUrls: [chainCfg.chain.blockExplorers?.default.url],
      }],
    });
  }
}

async function waitForTxConfirmation(
  hash: Hash,
  publicClient: PublicClient,
  label: string,
  explorerBase: string,
  chainLabel: string,
  timeoutMs = 120_000,
) {
  console.log(`Waiting for ${label} on ${chainLabel}…`, hash);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tx = await publicClient.getTransaction({ hash }).catch(() => null);
    if (tx) {
      console.log(`${label} found on ${chainLabel}, waiting for receipt…`);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: Math.max(15_000, timeoutMs - (Date.now() - start)),
      });
      if (receipt.status !== "success") {
        throw new Error(`${label} reverted on-chain. See ${explorerBase}/tx/${hash}`);
      }
      console.log(`${label} confirmed`);
      return receipt;
    }
    console.log(`${label} not on ${chainLabel} yet (${Math.round((Date.now() - start) / 1000)}s)…`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(
    `${label} never appeared on ${chainLabel} (${explorerBase}/tx/${hash}). ` +
    `Open your wallet → Activity, cancel pending ${chainLabel} transactions, then try again.`,
  );
}

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const API_FETCH: RequestInit = { credentials: "include" };
const GITHUB_APP_SLUG = import.meta.env.VITE_GITHUB_APP_SLUG ?? "bankr-vesting";

const ESCROW_ABI = parseAbi([
  "function lock(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile) external",
  "function lockAllowance(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile) external",
  "function lockWithPermit(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external",
  "function encodeRepoId(string calldata ownerSlashRepo) view returns (bytes32)",
]);

// Bankr DERC20 tokens implement a "locked pool" guard that blocks
// transferFrom to a pool address. We detect them at runtime by
// probing for the `isPoolUnlocked()` view function.

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

type Step = 1 | 2 | 3;

type BankrFeeToken = {
  address: string;
  name: string;
  symbol: string;
  share: string;
};

const SCHEDULE_PRESETS = [
  { label: "10 pushes → unlock all", totalPushes: 10, pushesPerMilestone: 10 },
  { label: "20 pushes → unlock all", totalPushes: 20, pushesPerMilestone: 20 },
  { label: "20 pushes → release every 5", totalPushes: 20, pushesPerMilestone: 5 },
  { label: "50 pushes → every 10", totalPushes: 50, pushesPerMilestone: 10 },
] as const;

type GitHubUser = {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string;
};

type RepoPlatform = "github" | "gitlawb";

type FormState = {
  platform: RepoPlatform;
  repoFullName: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenBalance: string;
  lockAmount: string;
  totalPushes: number;
  pushesPerMilestone: number;
  chain: VestingChainKey;
};

type SavedWizard = {
  step: Step;
  form: FormState;
  scheduleMode: "single" | "recurring";
};

const WIZARD_STORAGE_KEY = "proofofdev-create-wizard";

function loadSavedWizard(): SavedWizard | null {
  try {
    const raw = sessionStorage.getItem(WIZARD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedWizard;
    if (parsed.step < 1 || parsed.step > 3 || !parsed.form) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function CreatePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const chainKey = resolveCreatePageChain(searchParams);
  const chainCfg = getFrontendChainConfig(chainKey);
  const GIT_ESCROW_ADDRESS = chainCfg.escrowAddress;
  const { wallet: authWallet, githubUser, connectWallet: authConnectWallet, connectGitHub } = useVestingAuth();
  const repoFromUrl = searchParams.get("repo")?.trim() ?? "";
  const tokenFromUrl = searchParams.get("token")?.trim() ?? "";
  const savedWizard = loadSavedWizard();
  const [step, setStep] = useState<Step>(savedWizard?.step ?? 1);
  const [wallet, setWallet] = useState<Address | null>(null);
  const [form, setForm] = useState<FormState>(() => {
    if (savedWizard?.form) return savedWizard.form;
    return {
      platform: "github",
      repoFullName: repoFromUrl.includes("/") ? repoFromUrl : "",
      tokenAddress: tokenFromUrl || import.meta.env.VITE_MOCK_TOKEN_ADDRESS || "",
      tokenSymbol: "",
      tokenDecimals: 18,
      tokenBalance: "0",
      lockAmount: "",
      totalPushes: 10,
      pushesPerMilestone: 10,
      chain: chainKey,
    };
  });
  const [bankrTokens, setBankrTokens] = useState<BankrFeeToken[]>([]);
  const [bankrTokensLoading, setBankrTokensLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockTxHash, setLockTxHash] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState<number | null>(null);
  const [installCheck, setInstallCheck] = useState<{
    ok: boolean;
    message: string;
    installedRepos?: string[];
  } | null>(null);
  const [isBankrToken, setIsBankrToken] = useState(false);
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [allowanceReady, setAllowanceReady] = useState(false);
  const [chainNonce, setChainNonce] = useState<number | null>(null);
  const [gitlawbSetup, setGitlawbSetup] = useState<{ webhookUrl: string; webhookCommand: string } | null>(null);
  const [gitlawbWebhookReady, setGitlawbWebhookReady] = useState(false);
  const [scheduleMode, setScheduleMode] = useState<"single" | "recurring">(
    savedWizard?.scheduleMode ?? "single",
  );
  const [repoValidation, setRepoValidation] = useState<"idle" | "checking" | "ok" | "err">("idle");
  const [repoValidationMsg, setRepoValidationMsg] = useState("");
  const [repoClaimStatus, setRepoClaimStatus] = useState<"none" | "pending" | "verified">("none");
  const [repoClaimGithub, setRepoClaimGithub] = useState<string | null>(null);
  const [repoClaimBusy, setRepoClaimBusy] = useState(false);
  const [repoClaimFileJson, setRepoClaimFileJson] = useState<string | null>(null);
  const [repoClaimAgentPrompt, setRepoClaimAgentPrompt] = useState<string | null>(null);
  const [repoClaimMessage, setRepoClaimMessage] = useState<string | null>(null);
  const [myRepos, setMyRepos] = useState<string[]>([]);
  const didAutoValidateRepo = useRef(false);

  // Sync wallet from nav auth hook
  useEffect(() => {
    if (authWallet) setWallet(authWallet);
  }, [authWallet]);

  // Persist wizard progress so refresh / timeout does not reset the form
  useEffect(() => {
    const payload: SavedWizard = { step, form, scheduleMode };
    sessionStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(payload));
  }, [step, form, scheduleMode]);

  // Prefill repo from URL when arriving from verified-claim link
  useEffect(() => {
    if (!repoFromUrl.includes("/")) return;
    setForm((f) => (f.repoFullName ? f : { ...f, repoFullName: repoFromUrl }));
  }, [repoFromUrl]);

  // Validate repo + claim status once when prefilled from URL or restored session
  useEffect(() => {
    if (didAutoValidateRepo.current) return;
    const repo = form.repoFullName.trim();
    if (!repo.includes("/")) return;
    didAutoValidateRepo.current = true;
    void validateRepoOnBlur();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot on prefilled repo
  }, [form.repoFullName]);

  // Refresh claim badge when wallet connects
  useEffect(() => {
    const repo = form.repoFullName.trim();
    if (!wallet || !repo.includes("/")) return;
    void pollRepoClaimStatus(repo);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- poll when wallet/repo available
  }, [wallet, form.repoFullName]);

  // Load private + public repos when GitHub session is active
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

  // Restore wallet connection on page load if already connected.
  useEffect(() => {
    async function checkExistingWallet() {
      if (!(window as Window & { ethereum?: unknown }).ethereum) return;
      try {
        const eth = (window as Window & { ethereum: { request: (args: { method: string }) => Promise<string[]> } }).ethereum;
        const accounts = await eth.request({ method: "eth_accounts" });
        if (accounts && accounts.length > 0) {
          setWallet(accounts[0] as Address);
        }
      } catch { /* ignore */ }
    }
    void checkExistingWallet();
  }, []);

  useEffect(() => {
    if (!wallet || step < 3) return;
    setBankrTokensLoading(true);
    fetch(`${API_BASE}/api/bankr/fee-tokens?wallet=${wallet}`)
      .then((r) => r.json() as Promise<{ ok: boolean; tokens?: BankrFeeToken[] }>)
      .then((d) => setBankrTokens(d.tokens ?? []))
      .catch(() => setBankrTokens([]))
      .finally(() => setBankrTokensLoading(false));
  }, [wallet, step]);

  async function selectBankrToken(token: BankrFeeToken) {
    setForm((f) => ({ ...f, tokenAddress: token.address, tokenSymbol: token.symbol }));
    await loadTokenInfo(token.address);
  }

  useEffect(() => {
    if (form.platform !== "gitlawb") return;
    fetch(`${API_BASE}/api/gitlawb/setup`)
      .then((r) => r.json() as Promise<{ ok: boolean; webhookUrl?: string; webhookCommand?: string }>)
      .then((d) => {
        if (d.ok && d.webhookUrl && d.webhookCommand) {
          setGitlawbSetup({ webhookUrl: d.webhookUrl, webhookCommand: d.webhookCommand });
        }
      })
      .catch(() => setGitlawbSetup(null));
  }, [form.platform]);

  async function connectWallet() {
    if (!(window as Window & { ethereum?: unknown }).ethereum) {
      setError("No wallet detected. Install MetaMask or Coinbase Wallet.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const eth = (window as Window & { ethereum: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
      const accounts = await eth.request({ method: "eth_requestAccounts" }) as string[];
      setWallet(accounts[0] as Address);

      const expectedChainId = `0x${chainCfg.chain.id.toString(16)}`;
      const currentChainId = await eth.request({ method: "eth_chainId" }) as string;
      if (currentChainId !== expectedChainId) {
        setError(
          `Wrong network in MetaMask. Expected ${chainCfg.label} (chain ${expectedChainId}), got ${currentChainId}. ` +
          `Please switch networks in MetaMask and reconnect.`,
        );
        setBusy(false);
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connect failed");
    } finally {
      setBusy(false);
    }
  }

  async function loadTokenInfo(addressOverride?: string) {
    const tokenAddr = addressOverride ?? form.tokenAddress;
    if (!tokenAddr || !wallet) return;
    setBusy(true);
    setError(null);
    try {
      const client = createPublicClient({ chain: chainCfg.chain, transport: http(chainCfg.rpcUrl) });
      const addr = tokenAddr as Address;
      const [symbol, decimals, balance] = await Promise.all([
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" }),
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] }),
      ]);

      let detectedBankr = await detectStreamingToken(addr, chainKey, wallet, GIT_ESCROW_ADDRESS);

      setForm((f) => ({
        ...f,
        tokenSymbol: symbol as string,
        tokenDecimals: decimals as number,
        tokenBalance: ((balance as bigint) / BigInt(10 ** (decimals as number))).toString(),
      }));
      setIsBankrToken(detectedBankr);
    } catch (e) {
      setError("Could not load token info — check the address.");
    } finally {
      setBusy(false);
    }
  }

  async function pollRepoClaimStatus(repo: string) {
    if (!wallet || !repo.includes("/")) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/repo-claims/status?repo=${encodeURIComponent(repo)}&wallet=${wallet}&poll=1`,
        API_FETCH,
      );
      const d = await res.json() as {
        verified?: boolean;
        status?: string;
        claim?: { githubLogin?: string };
      };
      if (d.verified) {
        setRepoClaimStatus("verified");
        setRepoClaimGithub(d.claim?.githubLogin ?? null);
      } else if (d.status === "pending") {
        setRepoClaimStatus("pending");
      } else {
        setRepoClaimStatus("none");
      }
    } catch {
      /* ignore */
    }
  }

  async function startRepoClaim() {
    if (!wallet || !form.repoFullName.includes("/")) {
      setError("Connect wallet and enter owner/repo first");
      return;
    }
    setRepoClaimBusy(true);
    setError(null);
    setRepoClaimFileJson(null);
    setRepoClaimAgentPrompt(null);
    setRepoClaimMessage(null);
    try {
      const normalizedRepo = normalizeRepoFullName(form.repoFullName);
      const eth = (window as Window & { ethereum?: EthereumProvider }).ethereum;
      if (!eth) throw new Error("Wallet required to sign repo claim");

      const res = await fetch(`${API_BASE}/api/repo-claims/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wallet-address": wallet },
        body: JSON.stringify({ repo: normalizedRepo }),
        ...API_FETCH,
      });
      const challenge = await res.json() as {
        ok?: boolean;
        error?: string;
        claimId?: string;
        signMessage?: string;
      };
      if (!challenge.ok || !challenge.signMessage || !challenge.claimId) {
        throw new Error(challenge.error ?? "Failed to start repo claim");
      }

      const signature = (await eth.request({
        method: "personal_sign",
        params: [challenge.signMessage, wallet],
      })) as string;

      const prep = await fetch(`${API_BASE}/api/repo-claims/prepare-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimId: challenge.claimId, signature }),
      });
      const fileRes = await prep.json() as {
        ok?: boolean;
        error?: string;
        filePath?: string;
        fileContent?: unknown;
        commitMessage?: string;
      };
      if (!fileRes.ok || !fileRes.fileContent) {
        throw new Error(fileRes.error ?? "Failed to prepare claim file");
      }

      const json = JSON.stringify(fileRes.fileContent, null, 2);
      const filePath = fileRes.filePath ?? ".proofofdev/claim.json";
      const commitMessage = fileRes.commitMessage ?? `Proof of Dev: verify repo ownership`;
      setRepoClaimFileJson(json);
      setRepoClaimAgentPrompt(buildRepoClaimAgentPrompt({
        repoFullName: normalizedRepo,
        wallet,
        claimJson: json,
        filePath,
        commitMessage,
        apiBase: API_BASE,
      }));
      setRepoClaimStatus("pending");
      setRepoClaimMessage(
        `Push ${filePath} to main on ${normalizedRepo}. This push does not count toward vesting.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Repo claim failed");
    } finally {
      setRepoClaimBusy(false);
    }
  }

  async function validateRepoOnBlur() {
    const repo = normalizeRepoFullName(form.repoFullName);
    if (repo !== form.repoFullName.trim()) {
      setForm((f) => ({ ...f, repoFullName: repo }));
    }
    if (!isValidRepoFullName(repo)) {
      setRepoValidation("err");
      setRepoValidationMsg("Use owner/repo or a full github.com/owner/repo URL");
      return;
    }
    if (form.platform === "gitlawb") {
      setRepoValidation("ok");
      setRepoValidationMsg("GitLawb repo format OK");
      return;
    }
    setRepoValidation("checking");
    setRepoValidationMsg("");
    try {
      const res = await fetch(`${API_BASE}/api/github/repo?repo=${encodeURIComponent(repo)}`, API_FETCH);
      const d = await res.json() as {
        ok: boolean;
        repo?: string;
        error?: string;
        hint?: string;
        suggestions?: string[];
        needsGitHubLogin?: boolean;
        private?: boolean;
      };
      if (d.ok) {
        setRepoValidation("ok");
        const priv = d.private ? " (private)" : "";
        setRepoValidationMsg(`✓ ${d.repo ?? repo} found on GitHub${priv}`);
        void pollRepoClaimStatus(repo);
      } else {
        setRepoValidation("err");
        let msg = d.error ?? "Repository not found";
        if (d.needsGitHubLogin) msg += " — connect GitHub to access private repos.";
        else if (d.hint) msg += ` ${d.hint}`;
        setRepoValidationMsg(msg);
      }
    } catch {
      setRepoValidation("err");
      setRepoValidationMsg("Could not verify repo");
    }
  }

  useEffect(() => {
    if (scheduleMode === "single") {
      setForm((f) => ({ ...f, pushesPerMilestone: f.totalPushes }));
    }
  }, [scheduleMode, form.totalPushes]);

  useEffect(() => {
    if (step !== 3 || !wallet || !GIT_ESCROW_ADDRESS || !form.lockAmount) return;
    void (async () => {
      try {
        const readClient = createPublicClient({ chain: chainCfg.chain, transport: http(chainCfg.rpcUrl) });
        const amount = parseUnits(form.lockAmount, form.tokenDecimals);
        const [allowance, nonce] = await Promise.all([
          readClient.readContract({
            address: form.tokenAddress as Address,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [wallet, GIT_ESCROW_ADDRESS],
          }),
          readClient.getTransactionCount({ address: wallet, blockTag: "pending" }),
        ]);
        setAllowanceReady(allowance >= amount);
        setChainNonce(Number(nonce));
      } catch {
        setAllowanceReady(false);
        setChainNonce(null);
      }
    })();
  }, [step, wallet, form.lockAmount, form.tokenAddress, form.tokenDecimals, chainCfg]);

  async function ensureMetaMaskOnActiveChain(provider: EthereumProvider) {
    const chainIdHex = await provider.request({ method: "eth_chainId" });
    const chainId = Number.parseInt(String(chainIdHex), 16);
    if (chainId !== chainCfg.chain.id) {
      throw new Error(
        `MetaMask is on the wrong network (chain ${chainId}). Switch MetaMask to ${chainCfg.label} and try again.`,
      );
    }
  }

  async function getBaseNonce(readClient: PublicClient, walletAddr: Address) {
    const nonce = await readClient.getTransactionCount({
      address: walletAddr,
      blockTag: "pending",
    });
    setChainNonce(Number(nonce));
    return nonce;
  }

  function getLockContext(provider: EthereumProvider) {
    const readClient = createPublicClient({ chain: chainCfg.chain, transport: http(chainCfg.rpcUrl) });
    const walletClient = createWalletClient({
      chain: chainCfg.chain,
      transport: custom(provider),
      account: wallet!,
    });
    const amount = parseUnits(form.lockAmount, form.tokenDecimals);
    const tokenAddr = form.tokenAddress as Address;
    const lockFn = isBankrToken ? "lockAllowance" : "lock";
    const normalizedRepo = normalizeRepoFullName(form.repoFullName);
    const repoIdSeed = form.platform === "gitlawb"
      ? `gitlawb:${normalizedRepo}`
      : normalizedRepo;
    const repoIdBytes32 = keccak256(toBytes(repoIdSeed));
    const lockArgs = [
      repoIdBytes32,
      tokenAddr,
      amount,
      BigInt(form.totalPushes),
      BigInt(form.pushesPerMilestone),
    ] as const;
    return { readClient, walletClient, amount, tokenAddr, lockFn, lockArgs };
  }

  async function handleApproveTokens() {
    if (!wallet || !GIT_ESCROW_ADDRESS) return;
    const provider = (window as Window & { ethereum?: EthereumProvider }).ethereum;
    if (!provider) {
      setError("MetaMask not detected.");
      return;
    }

    setBusy(true);
    setError(null);
    setTxStatus(null);
    try {
      await ensureWalletChain(provider, chainCfg);
      await ensureMetaMaskOnActiveChain(provider);
      const { readClient, walletClient, amount, tokenAddr } = getLockContext(provider);
      const nonce = await getBaseNonce(readClient, wallet);

      console.log("Simulating approve…", { amount: amount.toString(), nonce: Number(nonce) });
      await readClient.simulateContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [GIT_ESCROW_ADDRESS, amount],
        account: wallet,
      });

      setTxStatus(
        `Confirm approve in MetaMask. Expected nonce: ${nonce}. ` +
        `If MetaMask shows a higher nonce or 'deceptive request', cancel pending ${chainCfg.label} txs first.`,
      );
      const approveTxHash = await walletClient.writeContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [GIT_ESCROW_ADDRESS, amount],
        nonce,
      });
      console.log("Approve tx sent:", approveTxHash);

      setTxStatus(`Waiting for approve to confirm on ${chainCfg.label}…`);
      await waitForTxConfirmation(approveTxHash, readClient, "Approve", chainCfg.explorerBase, chainCfg.label);

      const allowance = await readClient.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [wallet, GIT_ESCROW_ADDRESS],
      });
      if (allowance < amount) {
        throw new Error("Approve confirmed but allowance is still too low.");
      }
      setAllowanceReady(true);
      const streamingAfterApprove = await detectStreamingToken(
        tokenAddr,
        chainKey,
        wallet,
        GIT_ESCROW_ADDRESS,
      );
      setIsBankrToken(streamingAfterApprove);
      setTxStatus(
        streamingAfterApprove
          ? "Approve confirmed. This token uses streaming lock (lockAllowance). Click 'Lock tokens' below."
          : "Approve confirmed. Click 'Lock tokens' below.",
      );
    } catch (e: unknown) {
      console.error("handleApproveTokens error:", e);
      setError(e instanceof Error ? e.message : JSON.stringify(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleLockTokensFlow() {
    await handleLockGrant();
  }

  async function handleLockGrant() {
    if (!wallet || !GIT_ESCROW_ADDRESS) return;
    const provider = (window as Window & { ethereum?: EthereumProvider }).ethereum;
    if (!provider) {
      setError("MetaMask not detected.");
      return;
    }

    setBusy(true);
    setError(null);
    setTxStatus(null);
    try {
      await ensureWalletChain(provider, chainCfg);
      await ensureMetaMaskOnActiveChain(provider);
      const { readClient, walletClient, amount, tokenAddr, lockArgs } = getLockContext(provider);

      if (!allowanceReady) {
        let nonce = await getBaseNonce(readClient, wallet);
        setTxStatus("Confirm approve in MetaMask…");
        const approveTxHash = await walletClient.writeContract({
          address: tokenAddr,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [GIT_ESCROW_ADDRESS, amount],
          nonce,
        });
        await waitForTxConfirmation(approveTxHash, readClient, "Approve", chainCfg.explorerBase, chainCfg.label);
        setAllowanceReady(true);
      }

      const useStreaming = await detectStreamingToken(
        tokenAddr,
        chainKey,
        wallet,
        GIT_ESCROW_ADDRESS,
      );
      setIsBankrToken(useStreaming);
      let lockFnToUse: "lock" | "lockAllowance" =
        useStreaming ? "lockAllowance" : defaultLockFunction(chainKey);

      const lockNonce = await getBaseNonce(readClient, wallet);
      try {
        await readClient.simulateContract({
          address: GIT_ESCROW_ADDRESS,
          abi: ESCROW_ABI,
          functionName: lockFnToUse,
          args: lockArgs,
          account: wallet,
        });
      } catch (simErr: unknown) {
        const msg = extractErrorMessage(simErr);
        if (lockFnToUse === "lock" && /pull failed|lockAllowance|restricted/i.test(msg)) {
          lockFnToUse = "lockAllowance";
          setIsBankrToken(true);
          await readClient.simulateContract({
            address: GIT_ESCROW_ADDRESS,
            abi: ESCROW_ABI,
            functionName: lockFnToUse,
            args: lockArgs,
            account: wallet,
          });
        } else if (lockFnToUse === "lockAllowance" && /insufficient allowance/i.test(msg)) {
          throw new Error("Allowance too low — approve GitEscrow for the full lock amount, then retry.");
        } else {
          throw simErr;
        }
      }

      setTxStatus(`Confirm lock in MetaMask (${lockFnToUse === "lockAllowance" ? "streaming allowance" : "escrow deposit"})…`);
      const lockTxHash = await walletClient.writeContract({
        address: GIT_ESCROW_ADDRESS,
        abi: ESCROW_ABI,
        functionName: lockFnToUse,
        args: lockArgs,
        nonce: lockNonce,
      });
      console.log("Lock tx sent:", lockTxHash);

      setTxStatus(`Waiting for lock to confirm on ${chainCfg.label}…`);
      await waitForTxConfirmation(lockTxHash, readClient, "Lock", chainCfg.explorerBase, chainCfg.label);

      setLockTxHash(lockTxHash);

      await handleRegisterAfterLock(lockTxHash);
    } catch (e: unknown) {
      console.error("handleLockGrant error:", e);
      setError(e instanceof Error ? e.message : JSON.stringify(e));
    } finally {
      setBusy(false);
      setTxStatus(null);
    }
  }

  useEffect(() => {
    if (step !== 3 || !form.repoFullName.trim()) return;
    const q = new URLSearchParams({ repo: form.repoFullName.trim() });
    fetch(`${API_BASE}/api/github/installation?${q}`)
      .then((r) => r.json() as Promise<{
        ok: boolean;
        installationId?: number;
        error?: string;
        hint?: string;
        installedRepos?: string[];
        repo?: string;
      }>)
      .then((d) => {
        if (d.installationId) setInstallationId(d.installationId);
        setInstallCheck({
          ok: d.ok,
          message: d.ok
            ? `GitHub App can access ${d.repo ?? form.repoFullName}`
            : [d.error, d.hint].filter(Boolean).join(" — "),
          installedRepos: d.installedRepos,
        });
      })
      .catch(() => setInstallCheck({ ok: false, message: "Could not verify GitHub App access" }));
  }, [step, form.repoFullName]);

  async function handleRegisterAfterLock(txHash: string) {
    if (!wallet) return;
    setError(null);
    try {
      const milestones = form.totalPushes / form.pushesPerMilestone;
      const lockAmountWei = parseUnits(form.lockAmount, form.tokenDecimals);
      const tokensPerMilestone = (lockAmountWei / BigInt(milestones)).toString();

      const normalizedRepo = normalizeRepoFullName(form.repoFullName);

      const res = await fetch(`${API_BASE}/api/vesting/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoFullName: normalizedRepo,
          platform: "github",
          recipient: wallet,
          token: form.tokenAddress,
          chain: form.chain,
          totalLocked: lockAmountWei.toString(),
          totalPushesRequired: form.totalPushes,
          pushesPerMilestone: form.pushesPerMilestone,
          tokensPerMilestone,
          onChainTxHash: txHash,
          installationId: installationId ?? 0,
          streaming: isBankrToken,
        }),
      });
      const data = await res.json() as {
        ok: boolean;
        error?: string;
        hint?: string;
        lockPath?: string;
      };
      if (!data.ok && res.status !== 409) {
        throw new Error(data.error ?? "Registration failed");
      }
      sessionStorage.removeItem(WIZARD_STORAGE_KEY);
      navigate(data.lockPath ?? lockPathFromRepo(normalizedRepo));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Registration failed");
    }
  }

  const milestonesCount = form.totalPushes > 0 && form.pushesPerMilestone > 0
    ? form.totalPushes / form.pushesPerMilestone
    : 0;
  const tokensPerMilestoneDisplay = milestonesCount > 0 && form.lockAmount
    ? (parseFloat(form.lockAmount) / milestonesCount).toFixed(2)
    : "—";
  const tokensPerMilestoneWei = milestonesCount > 0 && form.lockAmount
    ? String(Math.floor((parseFloat(form.lockAmount) / milestonesCount) * 10 ** form.tokenDecimals))
    : "0";

  const schedulePreview = form.lockAmount && form.tokenSymbol
    ? scheduleMode === "single"
      ? `After ${form.totalPushes} verified pushes on main, ${form.lockAmount} ${form.tokenSymbol} release in one payout.`
      : `Every ${form.pushesPerMilestone} verified pushes, ${tokensPerMilestoneDisplay} ${form.tokenSymbol} releases (${milestonesCount} payouts).`
    : "";

  async function handleLockTokensFlow() {
    await handleLockGrant();
  }

  return (
    <div className="vesting-page vesting-page--wide">
      <VestingNav />
      <header>
        <h1>Create lock</h1>
        <p className="setup-step-label muted">Step {step} of 3</p>
      </header>

      {error && (
        <p className="err" style={{ whiteSpace: "pre-wrap", marginBottom: "1rem" }}>{error}</p>
      )}

      {step === 1 && (
        <section className="vesting-card setup-card">
          <h2>Repo & token</h2>
          {!wallet ? (
            <button type="button" className="btn btn-primary" onClick={() => void connectWallet()} disabled={busy}>
              Connect wallet first
            </button>
          ) : (
            <p className="muted">Wallet: <code>{wallet.slice(0, 6)}…{wallet.slice(-4)}</code></p>
          )}

          {!githubUser ? (
            <p className="muted">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => connectGitHub()}>
                Connect GitHub
              </button>
              {" "}to validate private repos and pick from your list.
            </p>
          ) : (
            <p className="muted">GitHub: <strong>@{githubUser.login}</strong> — private repos supported</p>
          )}

          <div className="create-grid">
            <label>
              GitHub repo
              <input
                type="text"
                placeholder="owner/repo"
                list={myRepos.length ? "my-github-repos" : undefined}
                value={form.repoFullName}
                onChange={(e) => {
                  setForm((f) => ({ ...f, repoFullName: e.target.value }));
                  setRepoValidation("idle");
                }}
                onBlur={() => void validateRepoOnBlur()}
              />
              {repoValidation === "ok" && <span className="field-hint ok">{repoValidationMsg}</span>}
              {repoValidation === "err" && <span className="field-hint err">{repoValidationMsg}</span>}
              {myRepos.length > 0 && (
                <datalist id="my-github-repos">
                  {myRepos.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
              )}
            </label>
            <label>
              Token address
              <input
                type="text"
                placeholder="0x…"
                value={form.tokenAddress}
                onChange={(e) => setForm((f) => ({ ...f, tokenAddress: e.target.value }))}
                onBlur={() => void loadTokenInfo()}
              />
              {form.tokenSymbol && (
                <span className="field-hint ok">✓ {form.tokenSymbol} · balance {form.tokenBalance}</span>
              )}
            </label>
          </div>

          {form.repoFullName.includes("/") && wallet && (
            <div className="repo-claim-box">
              <h3>Verify repo ownership</h3>
              <p className="muted">
                Bond your wallet to this repo by pushing a signed claim file. Optional before locking — agents can push it for you.
                {repoValidation === "err" && (
                  <span className="field-hint err"> Create the repo on GitHub first, then push the claim file.</span>
                )}
              </p>
              {repoClaimStatus === "verified" ? (
                <p className="field-hint ok">
                  ✓ Verified{repoClaimGithub ? ` — pushed by @${repoClaimGithub}` : ""}
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={repoClaimBusy || repoValidation === "err"}
                    onClick={() => void startRepoClaim()}
                  >
                    {repoClaimBusy ? "Signing…" : "Sign & get claim file"}
                  </button>
                  {repoClaimStatus === "pending" && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void pollRepoClaimStatus(form.repoFullName.trim())}
                    >
                      Check status
                    </button>
                  )}
                </>
              )}
              {repoClaimMessage && <p className="muted">{repoClaimMessage}</p>}
              {repoClaimFileJson && (
                <>
                  <div className="agents-code-block agents-code-block--wide">
                    <code>{repoClaimFileJson}</code>
                    <CopyButton text={repoClaimFileJson} icon label="Copy claim JSON" />
                  </div>
                  {repoClaimAgentPrompt && (
                    <div className="repo-claim-agent-prompt">
                      <p className="muted" style={{ marginBottom: "0.5rem" }}>
                        Paste into Cursor, Claude, Codex, or @bankrbot — the agent should push the file for you:
                      </p>
                      <div className="agents-code-block agents-code-block--wide">
                        <code>{repoClaimAgentPrompt}</code>
                        <CopyButton text={repoClaimAgentPrompt} icon label="Copy agent prompt" />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={!wallet || !form.repoFullName || !form.tokenAddress || repoValidation === "err"}
            onClick={() => {
              const repo = normalizeRepoFullName(form.repoFullName);
              if (!isValidRepoFullName(repo)) {
                setRepoValidation("err");
                setRepoValidationMsg("Use owner/repo or a full github.com/owner/repo URL");
                return;
              }
              setForm((f) => ({ ...f, repoFullName: repo }));
              setStep(2);
            }}
          >
            Next →
          </button>
        </section>
      )}

      {step === 2 && (
        <section className="vesting-card setup-card">
          <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>← Back</button>
          <h2>Schedule</h2>

          <label>
            Tokens to lock
            <input
              type="number"
              min="1"
              value={form.lockAmount}
              onChange={(e) => setForm((f) => ({ ...f, lockAmount: e.target.value }))}
            />
          </label>

          <div className="mode-cards">
            <button
              type="button"
              className={`mode-card${scheduleMode === "single" ? " active" : ""}`}
              onClick={() => setScheduleMode("single")}
            >
              <strong>One full release</strong>
              <span className="muted">All tokens unlock at once</span>
            </button>
            <button
              type="button"
              className={`mode-card${scheduleMode === "recurring" ? " active" : ""}`}
              onClick={() => setScheduleMode("recurring")}
            >
              <strong>Recurring releases</strong>
              <span className="muted">Unlock in multiple milestones</span>
            </button>
          </div>

          <label>
            Verified pushes required
            <input
              type="number"
              min="1"
              value={form.totalPushes}
              onChange={(e) => {
                const n = Number(e.target.value);
                setForm((f) => ({
                  ...f,
                  totalPushes: n,
                  pushesPerMilestone: scheduleMode === "single" ? n : f.pushesPerMilestone,
                }));
              }}
            />
          </label>

          {scheduleMode === "recurring" && (
            <label>
              Release every N pushes
              <input
                type="number"
                min="1"
                value={form.pushesPerMilestone}
                onChange={(e) => setForm((f) => ({ ...f, pushesPerMilestone: Number(e.target.value) }))}
              />
            </label>
          )}

          {schedulePreview && <p className="schedule-preview">{schedulePreview}</p>}

          <button
            type="button"
            className="btn btn-primary"
            disabled={!form.lockAmount || form.totalPushes < 1 || (scheduleMode === "recurring" && form.totalPushes % form.pushesPerMilestone !== 0)}
            onClick={() => setStep(3)}
          >
            Review →
          </button>
        </section>
      )}

      {step === 3 && (
        <section className="vesting-card setup-card">
          <button type="button" className="btn btn-ghost" onClick={() => setStep(2)}>← Back</button>
          <h2>Review & sign</h2>
          <div className="vesting-summary">
            <p><strong>Repo:</strong> {form.repoFullName}</p>
            <p><strong>Token:</strong> {form.tokenSymbol} ({form.tokenAddress.slice(0, 10)}…)</p>
            <p><strong>Amount:</strong> {form.lockAmount} {form.tokenSymbol}</p>
            <p><strong>Schedule:</strong> {schedulePreview}</p>
          </div>

          <a
            href={`https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary"
            style={{ marginBottom: "1rem", display: "block", textAlign: "center" }}
          >
            Install GitHub App on repo →
          </a>
          {installCheck && (
            <p className={installCheck.ok ? "ok-msg" : "err"}>{installCheck.message}</p>
          )}

          {txStatus && <p className="muted">{txStatus}</p>}

          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !GIT_ESCROW_ADDRESS}
            onClick={() => void handleLockTokensFlow()}
          >
            {busy ? (txStatus ?? "Signing…") : "Lock tokens"}
          </button>
        </section>
      )}

      <VestingFooter />
    </div>
  );
}
