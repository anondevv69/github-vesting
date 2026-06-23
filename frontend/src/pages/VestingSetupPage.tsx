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
import { useSearchParams, Link } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
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

type Step = 1 | 2 | 3 | 4 | 5 | 6;

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

export function VestingSetupPage() {
  const [searchParams] = useSearchParams();
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
        setStep(3);
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

      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connect failed");
    } finally {
      setBusy(false);
    }
  }

  function connectGitHub() {
    const returnTo = encodeURIComponent("/vesting/setup");
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

  useEffect(() => {
    if (step !== 5 || !wallet || !GIT_ESCROW_ADDRESS || !form.lockAmount) return;
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

  async function handleLockGrant() {
    if (!wallet || !GIT_ESCROW_ADDRESS || !allowanceReady) return;
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
      const { readClient, walletClient, lockFn, lockArgs } = getLockContext(provider);
      const nonce = await getBaseNonce(readClient, wallet);

      console.log("Simulating lock via", lockFn);
      await readClient.simulateContract({
        address: GIT_ESCROW_ADDRESS,
        abi: ESCROW_ABI,
        functionName: lockFn,
        args: lockArgs,
        account: wallet,
      });

      setTxStatus("Confirm lock in MetaMask…");
      const lockTxHash = await walletClient.writeContract({
        address: GIT_ESCROW_ADDRESS,
        abi: ESCROW_ABI,
        functionName: lockFn,
        args: lockArgs,
        nonce,
      });
      console.log("Lock tx sent:", lockTxHash);

      setTxStatus("Waiting for lock to confirm on Base…");
      await waitForTxConfirmation(lockTxHash, readClient, "Lock");

      setLockTxHash(lockTxHash);
      setStep(6);
    } catch (e: unknown) {
      console.error("handleLockGrant error:", e);
      setError(e instanceof Error ? e.message : JSON.stringify(e));
    } finally {
      setBusy(false);
      setTxStatus(null);
    }
  }

  useEffect(() => {
    if (step !== 6 || form.platform !== "github" || !form.repoFullName.trim()) return;
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
  }, [step, form.platform, form.repoFullName]);

  async function handleRegister() {
    if (!wallet || !lockTxHash) return;
    if (form.platform === "github" && !githubUser) return;
    if (form.platform === "gitlawb" && !gitlawbWebhookReady) return;
    setBusy(true);
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
          platform: form.platform,
          recipient: wallet,
          token: form.tokenAddress,
          chain: form.chain,
          totalLocked: (parseFloat(form.lockAmount) * 10 ** form.tokenDecimals).toString(),
          totalPushesRequired: form.totalPushes,
          pushesPerMilestone: form.pushesPerMilestone,
          tokensPerMilestone,
          onChainTxHash: lockTxHash,
          installationId: form.platform === "github" ? installationId : 0,
          streaming: isBankrToken,
        }),
      });
      const data = await res.json() as {
        ok: boolean;
        error?: string;
        hint?: string;
        installedRepos?: string[];
        repo?: string;
      };
      if (!data.ok && res.status !== 409) {
        const extra = [
          data.hint,
          data.installedRepos?.length
            ? `App can access: ${data.installedRepos.slice(0, 8).join(", ")}`
            : undefined,
        ].filter(Boolean).join("\n");
        throw new Error([data.error ?? "Registration failed", extra].filter(Boolean).join("\n"));
      }
      setError(null);
      alert("Vesting activated! Push verified commits to your repo to release tokens.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Registration failed");
    } finally {
      setBusy(false);
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

  return (
    <div className="vesting-page">
      <VestingNav />
      <header className="vesting-setup-page__header">
        <h1>Git Vesting</h1>
        <p className="muted">
          Lock tokens — earn them back by shipping verified commits on <strong>GitHub</strong> or{" "}
          <a href="https://gitlawb.com/start" target="_blank" rel="noreferrer">GitLawb</a>.
        </p>
      </header>

      <div className="vesting-setup-page__steps">
        {[1, 2, 3, 4, 5, 6].map((s) => (
          <div key={s} className={`step-dot ${step === s ? "active" : step > s ? "done" : ""}`}>
            {s}
          </div>
        ))}
      </div>

      {error && (
        <p className="err" style={{ whiteSpace: "pre-wrap", marginBottom: "1rem" }}>{error}</p>
      )}

      {/* Step 1: Connect wallet */}
      {step === 1 && (
        <section className="vesting-card">
          <h2>Step 1 — Connect wallet & choose platform</h2>
          <p className="muted">Connect the wallet that is the fee recipient for your token.</p>
          <div className="preset-row">
            <button
              type="button"
              className={`preset-btn ${form.platform === "github" ? "active" : ""}`}
              onClick={() => setForm((f) => ({ ...f, platform: "github" }))}
            >
              GitHub
            </button>
            <button
              type="button"
              className={`preset-btn ${form.platform === "gitlawb" ? "active" : ""}`}
              onClick={() => setForm((f) => ({ ...f, platform: "gitlawb" }))}
            >
              GitLawb (agents / Base)
            </button>
          </div>
          <button className="btn btn-primary" onClick={() => void connectWallet()} disabled={busy}>
            {busy ? "Connecting…" : "Connect Wallet"}
          </button>
        </section>
      )}

      {step === 2 && form.platform === "github" && (
        <section className="vesting-card">
          <h2>Step 2 — Connect GitHub</h2>
          <p className="muted">Wallet connected: <code>{wallet}</code></p>
          <p className="muted">We need read access to your repo so our bot can verify your pushes.</p>
          <button className="btn btn-primary" onClick={connectGitHub}>
            Connect GitHub →
          </button>
        </section>
      )}

      {step === 2 && form.platform === "gitlawb" && (
        <section className="vesting-card">
          <h2>Step 2 — GitLawb identity</h2>
          <p className="muted">Wallet connected: <code>{wallet}</code></p>
          <p className="muted">
            GitLawb uses a DID identity (no passwords). Install the CLI and create your agent identity:
          </p>
          <pre className="code-block">{`curl -fsSL https://gitlawb.com/install.sh | sh
export GITLAWB_NODE=https://node.gitlawb.com
gl identity new
gl register
gl repo create my-project`}</pre>
          <p className="muted">
            Docs:{" "}
            <a href="https://gitlawb.com/start" target="_blank" rel="noreferrer">Get started</a>
            {" · "}
            <a href="https://gitlawb.com/agents" target="_blank" rel="noreferrer">Agents</a>
            {" · "}
            <a href="https://gitlawb.com/node/repos" target="_blank" rel="noreferrer">Browse repos</a>
          </p>
          <button className="btn btn-primary" onClick={() => setStep(3)}>
            I have a GitLawb repo →
          </button>
        </section>
      )}

      {/* Step 3: Repo + token details */}
      {step === 3 && (
        <section className="vesting-card">
          <h2>Step 3 — Your repo & token</h2>
          {githubUser && (
            <p className="muted">
              GitHub: <strong>@{githubUser.login}</strong>
            </p>
          )}
          <label>
            {form.platform === "gitlawb" ? "GitLawb repo (ownerShort/repo)" : "GitHub repo (owner/repo)"}
            <input
              type="text"
              placeholder={form.platform === "gitlawb" ? "z6Mk…/my-project" : "myorg/my-token-project"}
              value={form.repoFullName}
              onChange={(e) => setForm((f) => ({ ...f, repoFullName: e.target.value }))}
            />
          </label>
          {form.platform === "gitlawb" && form.repoFullName.includes("/") && (
            <p className="muted">
              <a
                href={`${API_BASE}/api/gitlawb/repo?repo=${encodeURIComponent(form.repoFullName)}`}
                target="_blank"
                rel="noreferrer"
              >
                Verify repo on GitLawb node →
              </a>
            </p>
          )}

          {bankrTokensLoading && <p className="muted">Loading Bankr fee-recipient tokens…</p>}
          {!bankrTokensLoading && bankrTokens.length > 0 && (
            <div className="token-picker">
              <p className="muted">Your Bankr fee-recipient tokens — pick one:</p>
              <div className="token-picker__grid">
                {bankrTokens.map((t) => (
                  <button
                    key={t.address}
                    type="button"
                    className={`token-chip ${form.tokenAddress.toLowerCase() === t.address.toLowerCase() ? "active" : ""}`}
                    onClick={() => void selectBankrToken(t)}
                  >
                    <strong>{t.symbol || t.name || "Token"}</strong>
                    <span>{t.address.slice(0, 6)}…{t.address.slice(-4)}</span>
                    {t.share && <span className="muted">{t.share} share</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label>
            Or paste ERC-20 address (Base)
            <input
              type="text"
              placeholder="0x…"
              value={form.tokenAddress}
              onChange={(e) => setForm((f) => ({ ...f, tokenAddress: e.target.value }))}
              onBlur={() => void loadTokenInfo()}
            />
          </label>
          {form.tokenSymbol && (
            <p className="muted">
              Token: <strong>{form.tokenSymbol}</strong> · Your balance:{" "}
              <strong>{form.tokenBalance}</strong>
              {" · "}
              <Link to={`/vesting/token/${form.tokenAddress}`}>View locks on this token</Link>
            </p>
          )}
          <button
            className="btn btn-primary"
            disabled={!form.repoFullName || !form.tokenAddress || busy}
            onClick={() => setStep(4)}
          >
            Next →
          </button>
        </section>
      )}

      {/* Step 4: Vesting schedule */}
      {step === 4 && (
        <section className="vesting-card">
          <h2>Step 4 — How many verified pushes?</h2>
          <label>
            Tokens to lock
            <input
              type="number"
              min="1"
              placeholder={`Max ${form.tokenBalance}`}
              value={form.lockAmount}
              onChange={(e) => setForm((f) => ({ ...f, lockAmount: e.target.value }))}
            />
          </label>

          <p className="muted">Quick schedules:</p>
          <div className="preset-row">
            {SCHEDULE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`preset-btn ${
                  form.totalPushes === p.totalPushes && form.pushesPerMilestone === p.pushesPerMilestone
                    ? "active"
                    : ""
                }`}
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    totalPushes: p.totalPushes,
                    pushesPerMilestone: p.pushesPerMilestone,
                  }))
                }
              >
                {p.label}
              </button>
            ))}
          </div>

          <label>
            Total verified pushes to unlock everything
            <input
              type="number"
              min="1"
              value={form.totalPushes}
              onChange={(e) => setForm((f) => ({ ...f, totalPushes: Number(e.target.value) }))}
            />
          </label>
          <label>
            Release every N verified pushes
            <input
              type="number"
              min="1"
              value={form.pushesPerMilestone}
              onChange={(e) =>
                setForm((f) => ({ ...f, pushesPerMilestone: Number(e.target.value) }))
              }
            />
          </label>
          <p className="muted small">
            Set release interval equal to total pushes for a single payout at the end.
          </p>

          {milestonesCount > 0 && form.lockAmount && (
            <VestingPathChart
              totalPushes={form.totalPushes}
              pushesPerMilestone={form.pushesPerMilestone}
              tokensPerMilestone={tokensPerMilestoneWei}
              tokenSymbol={form.tokenSymbol || "tokens"}
            />
          )}

          <button
            className="btn btn-primary"
            disabled={
              !form.lockAmount ||
              milestonesCount <= 0 ||
              form.totalPushes % form.pushesPerMilestone !== 0
            }
            onClick={() => setStep(5)}
          >
            Review & Lock →
          </button>
          {form.totalPushes % form.pushesPerMilestone !== 0 && (
            <p className="err small">Total pushes must divide evenly by release interval.</p>
          )}
        </section>
      )}

      {/* Step 5: Approve + lock on-chain */}
      {step === 5 && (
        <section className="vesting-card">
          <h2>Step 5 — Lock tokens on-chain</h2>
          <div className="vesting-summary">
            <p><strong>Repo:</strong> {form.repoFullName}</p>
            <p><strong>Token:</strong> {form.tokenSymbol} ({form.tokenAddress})</p>
            <p><strong>Lock:</strong> {form.lockAmount} {form.tokenSymbol}</p>
            <p>
              <strong>Schedule:</strong> {tokensPerMilestoneDisplay} {form.tokenSymbol} per{" "}
              {form.pushesPerMilestone} verified pushes ({milestonesCount} milestones,{" "}
              {form.totalPushes} total pushes)
            </p>
          </div>
          <p className="muted">
            Two steps: (1) approve escrow, (2) lock tokens.
            {isBankrToken
              ? " Bankr-style tokens use streaming allowance — tokens stay in your wallet until milestones hit."
              : " Tokens stay in the escrow contract until milestones are hit."}
            {" "}This is a commitment lock — tokens only release when verified pushes are completed.
          </p>
          <div className="vesting-preview">
            {chainNonce !== null && (
              <p className="muted">
                Your next Base transaction should use nonce <strong>{chainNonce}</strong>.
                In the MetaMask popup, confirm the network is <strong>Base</strong> and the nonce matches.
              </p>
            )}
            <p className="muted">
              <strong>MetaMask says "deceptive request"?</strong> The spender{" "}
              <a href={`https://basescan.org/address/${GIT_ESCROW_ADDRESS}`} target="_blank" rel="noreferrer">
                {GIT_ESCROW_ADDRESS?.slice(0, 10)}…
              </a>{" "}
              is your GitEscrow contract. MetaMask flags new contracts — click through only if you trust this app.
            </p>
            <p className="muted">
              Txs showing <strong>Failed</strong> or missing on{" "}
              <a href="https://basescan.org" target="_blank" rel="noreferrer">Basescan</a>?
              MetaMask → Activity → <strong>cancel all pending Base transactions</strong>.
              Still stuck? Settings → Advanced → <strong>Clear activity tab data</strong> for this account.
            </p>
          </div>
          {txStatus && <p className="muted">{txStatus}</p>}
          {allowanceReady && !busy && (
            <p className="muted">✓ Allowance set — ready to lock.</p>
          )}
          <button
            className="btn btn-primary"
            disabled={busy || allowanceReady}
            onClick={() => void handleApproveTokens()}
          >
            {busy && !allowanceReady ? (txStatus ?? "Approving…") : "1. Approve escrow →"}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !allowanceReady}
            onClick={() => void handleLockGrant()}
            style={{ marginLeft: "0.5rem" }}
          >
            {busy && allowanceReady ? (txStatus ?? "Locking…") : "2. Lock tokens →"}
          </button>
        </section>
      )}

      {/* Step 6: Activate (GitHub App or GitLawb webhook) */}
      {step === 6 && form.platform === "github" && (
        <section className="vesting-card">
          <h2>Step 6 — Install GitHub App & activate</h2>
          {lockTxHash && (
            <p className="muted">
              Lock tx:{" "}
              <a href={`${IS_TESTNET ? "https://sepolia.basescan.org" : "https://basescan.org"}/tx/${lockTxHash}`} target="_blank" rel="noreferrer">
                {lockTxHash.slice(0, 10)}…
              </a>
            </p>
          )}
          <p className="muted">
            Repo: <code>{form.repoFullName}</code> — the GitHub App must be installed on <strong>this exact repo</strong>.
          </p>
          <p>
            Install the GitHub App on <code>{form.repoFullName}</code> so it can receive push webhooks
            and verify your commits.
          </p>
          <a
            href={`https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary"
          >
            Install GitHub App →
          </a>
          {installCheck && (
            <p className={installCheck.ok ? "ok-msg" : "err"} style={{ whiteSpace: "pre-wrap" }}>
              {installCheck.message}
            </p>
          )}
          <label style={{ marginTop: "1rem" }}>
            GitHub App Installation ID (optional — auto-detected when possible)
            <input
              type="number"
              placeholder="141219448"
              value={installationId ?? ""}
              onChange={(e) => setInstallationId(e.target.value ? Number(e.target.value) : null)}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void handleRegister()}
          >
            {busy ? "Activating…" : "Activate vesting →"}
          </button>
        </section>
      )}

      {step === 6 && form.platform === "gitlawb" && (
        <section className="vesting-card">
          <h2>Step 6 — GitLawb webhook & activate</h2>
          {lockTxHash && (
            <p className="muted">
              Lock tx:{" "}
              <a href={`${IS_TESTNET ? "https://sepolia.basescan.org" : "https://basescan.org"}/tx/${lockTxHash}`} target="_blank" rel="noreferrer">
                {lockTxHash.slice(0, 10)}…
              </a>
            </p>
          )}
          <p>
            Register a push webhook on your GitLawb repo so verified pushes trigger vesting releases.
          </p>
          {gitlawbSetup && (
            <pre className="code-block">{gitlawbSetup.webhookCommand.replace("YOUR_REPO", form.repoFullName.split("/")[1] ?? "my-project")}</pre>
          )}
          <p className="muted">
            Webhook URL: <code>{gitlawbSetup?.webhookUrl ?? `${API_BASE}/api/webhook/gitlawb`}</code>
          </p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={gitlawbWebhookReady}
              onChange={(e) => setGitlawbWebhookReady(e.target.checked)}
            />
            I ran <code>gl webhook create</code> for this repo
          </label>
          <button
            className="btn btn-primary"
            disabled={!gitlawbWebhookReady || busy}
            onClick={() => void handleRegister()}
          >
            {busy ? "Activating…" : "Activate vesting →"}
          </button>
        </section>
      )}

      <style>{`
        .vesting-setup-page__header { margin-bottom: 2rem; }
        .vesting-setup-page__steps { display: flex; gap: 0.5rem; margin-bottom: 2rem; }
        .step-dot { width: 2rem; height: 2rem; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.85rem; background: #e5e7eb; color: #6b7280; }
        .step-dot.active { background: #7c3aed; color: white; }
        .step-dot.done { background: #10b981; color: white; }
        .vesting-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 0.75rem; padding: 1.5rem; margin-bottom: 1.5rem; }
        .vesting-card h2 { margin: 0 0 0.75rem; font-size: 1.1rem; }
        label { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 1rem; font-size: 0.9rem; font-weight: 500; }
        input[type=text], input[type=number] { padding: 0.5rem 0.75rem; border: 1px solid #d1d5db; border-radius: 0.4rem; font-size: 0.9rem; }
        .btn { padding: 0.55rem 1.2rem; border-radius: 0.4rem; font-weight: 600; cursor: pointer; border: none; font-size: 0.9rem; }
        .btn-primary { background: #7c3aed; color: white; }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-secondary { background: #1f2937; color: white; text-decoration: none; display: inline-block; }
        .vesting-preview { background: #f9fafb; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem; }
        .vesting-summary p { margin: 0.3rem 0; font-size: 0.9rem; }
        .muted { color: #6b7280; font-size: 0.875rem; }
        .err { color: #dc2626; font-size: 0.875rem; }
        code { background: #f3f4f6; padding: 0.2rem 0.4rem; border-radius: 0.25rem; font-size: 0.8rem; }
        .token-picker { margin: 1rem 0; }
        .token-picker__grid { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
        .token-chip {
          display: flex; flex-direction: column; align-items: flex-start; gap: 0.15rem;
          padding: 0.6rem 0.85rem; border-radius: 0.5rem; border: 1px solid #d1d5db;
          background: #fff; cursor: pointer; font-size: 0.8rem; text-align: left;
        }
        .token-chip.active { border-color: #7c3aed; background: #faf5ff; }
        .preset-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
        .preset-btn {
          padding: 0.45rem 0.75rem; border-radius: 9999px; border: 1px solid #d1d5db;
          background: #fff; cursor: pointer; font-size: 0.8rem;
        }
        .preset-btn.active { background: #7c3aed; color: #fff; border-color: #7c3aed; }
        .small { font-size: 0.8rem; }
        .code-block {
          background: #1e1b4b; color: #e9d5ff; padding: 1rem; border-radius: 0.5rem;
          font-size: 0.8rem; overflow-x: auto; white-space: pre-wrap;
        }
        .checkbox-row { display: flex; align-items: center; gap: 0.5rem; margin: 1rem 0; font-size: 0.9rem; }
      `}</style>
    </div>
  );
}
