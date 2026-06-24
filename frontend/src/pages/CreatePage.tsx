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

import { useState, useEffect } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { VestingFooter } from "../components/VestingFooter";
import { VestingPathChart } from "../components/VestingPathChart";
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
import { base, baseSepolia } from "viem/chains";

const IS_TESTNET = import.meta.env.VITE_CHAIN === "base-sepolia";
const activeChain = IS_TESTNET ? baseSepolia : base;
const RPC_URL =
  import.meta.env.VITE_BASE_RPC_URL ??
  (IS_TESTNET ? "https://sepolia.base.org" : "https://mainnet.base.org");

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

async function ensureWalletChain(provider: EthereumProvider) {
  const chainIdHex = `0x${activeChain.id.toString(16)}`;
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
        chainName: activeChain.name,
        nativeCurrency: activeChain.nativeCurrency,
        rpcUrls: [RPC_URL],
        blockExplorerUrls: [activeChain.blockExplorers?.default.url],
      }],
    });
  }
}

async function waitForTxConfirmation(
  hash: Hash,
  publicClient: PublicClient,
  label: string,
  timeoutMs = 120_000,
) {
  const explorer = IS_TESTNET ? "https://sepolia.basescan.org" : "https://basescan.org";
  console.log(`Waiting for ${label} on Base…`, hash);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Poll the public Base RPC only — MetaMask's provider can report local
    // pending txs that never actually broadcast to the network.
    const tx = await publicClient.getTransaction({ hash }).catch(() => null);
    if (tx) {
      console.log(`${label} found on Base, waiting for receipt…`);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: Math.max(15_000, timeoutMs - (Date.now() - start)),
      });
      if (receipt.status !== "success") {
        throw new Error(`${label} reverted on-chain. See ${explorer}/tx/${hash}`);
      }
      console.log(`${label} confirmed`);
      return receipt;
    }
    console.log(`${label} not on Base yet (${Math.round((Date.now() - start) / 1000)}s)…`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(
    `${label} never appeared on Base (${explorer}/tx/${hash}). ` +
    "MetaMask likely queued it without broadcasting. Open MetaMask → Activity, cancel ALL pending Base transactions, then try again.",
  );
}

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const GIT_ESCROW_ADDRESS = import.meta.env.VITE_GIT_ESCROW_ADDRESS as Address | undefined;
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
  chain: "base" | "base-sepolia";
};

export function CreatePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(1);
  const [wallet, setWallet] = useState<Address | null>(null);
  const [githubUser, setGithubUser] = useState<GitHubUser | null>(null);
  const [form, setForm] = useState<FormState>({
    platform: "github",
    repoFullName: "",
    tokenAddress: import.meta.env.VITE_MOCK_TOKEN_ADDRESS ?? "",
    tokenSymbol: "",
    tokenDecimals: 18,
    tokenBalance: "0",
    lockAmount: "",
    totalPushes: 10,
    pushesPerMilestone: 10,
    chain: IS_TESTNET ? "base-sepolia" : "base",
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
  const [scheduleMode, setScheduleMode] = useState<"single" | "recurring">("single");
  const [repoValidation, setRepoValidation] = useState<"idle" | "checking" | "ok" | "err">("idle");
  const [repoValidationMsg, setRepoValidationMsg] = useState("");

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

  // Parse GitHub OAuth callback params.
  useEffect(() => {
    const githubUserParam = searchParams.get("github_user");
    const oauthError = searchParams.get("error");
    if (githubUserParam) {
      try {
        const user = JSON.parse(decodeURIComponent(githubUserParam)) as GitHubUser;
        setGithubUser(user);
        localStorage.setItem("vesting_github_user", JSON.stringify(user));
        setStep(1);
      } catch {
        setError("Failed to parse GitHub user info.");
      }
    } else {
      const saved = localStorage.getItem("vesting_github_user");
      if (saved) setGithubUser(JSON.parse(saved) as GitHubUser);
    }
    if (oauthError) {
      setError(decodeURIComponent(oauthError));
    }
  }, [searchParams]);

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

      // Verify the wallet is on the correct chain (Base or Base Sepolia).
      const expectedChainId = IS_TESTNET ? "0x14a34" : "0x2105"; // 84532 / 8453
      const currentChainId = await eth.request({ method: "eth_chainId" }) as string;
      if (currentChainId !== expectedChainId) {
        setError(
          `Wrong network in MetaMask. Expected ${IS_TESTNET ? "Base Sepolia" : "Base"} (chain ${expectedChainId}), got ${currentChainId}. ` +
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

  function connectGitHub() {
    const returnTo = encodeURIComponent("/create");
    window.location.href = `${API_BASE}/api/oauth/github?returnTo=${returnTo}`;
  }

  async function loadTokenInfo(addressOverride?: string) {
    const tokenAddr = addressOverride ?? form.tokenAddress;
    if (!tokenAddr || !wallet) return;
    setBusy(true);
    setError(null);
    try {
      const client = createPublicClient({ chain: activeChain, transport: http(RPC_URL) });
      const addr = tokenAddr as Address;
      const [symbol, decimals, balance] = await Promise.all([
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" }),
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] }),
      ]);

      // Probe for Bankr DERC20 (locked-pool) interface by checking if
      // the contract has bytecode at the lockPool(address) selector.
      // We do this by attempting a static call to `isPoolUnlocked()` view
      // (selector 0x5a9c4d63) — if it reverts with no data, it's a
      // standard ERC-20. If it returns, it's Bankr-style.
      let detectedBankr = false;
      try {
        await client.readContract({
          address: addr,
          abi: parseAbi(["function isPoolUnlocked() view returns (bool)"]),
          functionName: "isPoolUnlocked",
        });
        detectedBankr = true;
      } catch {
        detectedBankr = false;
      }

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

  async function validateRepoOnBlur() {
    const repo = form.repoFullName.trim();
    if (!repo.includes("/")) {
      setRepoValidation("err");
      setRepoValidationMsg("Use owner/repo format");
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
      const res = await fetch(`${API_BASE}/api/github/repo?repo=${encodeURIComponent(repo)}`);
      const d = await res.json() as { ok: boolean; repo?: string; error?: string };
      if (d.ok) {
        setRepoValidation("ok");
        setRepoValidationMsg(`✓ ${d.repo ?? repo} found on GitHub`);
      } else {
        setRepoValidation("err");
        setRepoValidationMsg(d.error ?? "Repository not found");
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
        const readClient = createPublicClient({ chain: activeChain, transport: http(RPC_URL) });
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
  }, [step, wallet, form.lockAmount, form.tokenAddress, form.tokenDecimals]);

  async function ensureMetaMaskOnActiveChain(provider: EthereumProvider) {
    const chainIdHex = await provider.request({ method: "eth_chainId" });
    const chainId = Number.parseInt(String(chainIdHex), 16);
    if (chainId !== activeChain.id) {
      throw new Error(
        `MetaMask is on the wrong network (chain ${chainId}). Switch MetaMask to ${activeChain.name} and try again.`,
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
    const readClient = createPublicClient({ chain: activeChain, transport: http(RPC_URL) });
    const walletClient = createWalletClient({
      chain: activeChain,
      transport: custom(provider),
      account: wallet!,
    });
    const amount = parseUnits(form.lockAmount, form.tokenDecimals);
    const tokenAddr = form.tokenAddress as Address;
    const lockFn = isBankrToken ? "lockAllowance" : "lock";
    const repoIdSeed = form.platform === "gitlawb"
      ? `gitlawb:${form.repoFullName.trim()}`
      : form.repoFullName.trim();
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
      await ensureWalletChain(provider);
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
        "If MetaMask shows a higher nonce or 'deceptive request', cancel pending Base txs first.",
      );
      const approveTxHash = await walletClient.writeContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [GIT_ESCROW_ADDRESS, amount],
        nonce,
      });
      console.log("Approve tx sent:", approveTxHash);

      setTxStatus("Waiting for approve to confirm on Base…");
      await waitForTxConfirmation(approveTxHash, readClient, "Approve");

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
      setTxStatus("Approve confirmed. Click 'Lock tokens' below.");
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
      await ensureWalletChain(provider);
      await ensureMetaMaskOnActiveChain(provider);
      const { readClient, walletClient, amount, tokenAddr, lockFn, lockArgs } = getLockContext(provider);

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
        await waitForTxConfirmation(approveTxHash, readClient, "Approve");
        setAllowanceReady(true);
      }

      const lockNonce = await getBaseNonce(readClient, wallet);
      setTxStatus("Confirm lock in MetaMask…");
      const lockTxHash = await walletClient.writeContract({
        address: GIT_ESCROW_ADDRESS,
        abi: ESCROW_ABI,
        functionName: lockFn,
        args: lockArgs,
        nonce: lockNonce,
      });
      console.log("Lock tx sent:", lockTxHash);

      setTxStatus("Waiting for lock to confirm on Base…");
      await waitForTxConfirmation(lockTxHash, readClient, "Lock");

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

      const res = await fetch(`${API_BASE}/api/vesting/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoFullName: form.repoFullName,
          platform: "github",
          recipient: wallet,
          token: form.tokenAddress,
          chain: form.chain,
          totalLocked: (parseFloat(form.lockAmount) * 10 ** form.tokenDecimals).toString(),
          totalPushesRequired: form.totalPushes,
          pushesPerMilestone: form.pushesPerMilestone,
          tokensPerMilestone,
          onChainTxHash: txHash,
          installationId: installationId ?? 0,
          streaming: isBankrToken,
        }),
      });
      const data = await res.json() as { ok: boolean; error?: string; hint?: string };
      if (!data.ok && res.status !== 409) {
        throw new Error(data.error ?? "Registration failed");
      }
      const [owner, name] = form.repoFullName.split("/");
      navigate(`/lock/${owner}/${name}`);
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
      <header className="vesting-setup-page__header">
        <h1>Create lock</h1>
      </header>

      <p className="setup-step-label setup-step-label--center">Step {step} of 3</p>

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

          <div className="create-grid">
            <label>
              GitHub repo
              <input
                type="text"
                placeholder="owner/repo"
                value={form.repoFullName}
                onChange={(e) => {
                  setForm((f) => ({ ...f, repoFullName: e.target.value }));
                  setRepoValidation("idle");
                }}
                onBlur={() => void validateRepoOnBlur()}
              />
              {repoValidation === "ok" && <span className="field-hint ok">{repoValidationMsg}</span>}
              {repoValidation === "err" && <span className="field-hint err">{repoValidationMsg}</span>}
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

          <button
            type="button"
            className="btn btn-primary"
            disabled={!wallet || !form.repoFullName || !form.tokenAddress || repoValidation === "err"}
            onClick={() => setStep(2)}
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
