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
import { useSearchParams } from "react-router-dom";
import { createPublicClient, http, parseAbi, keccak256, toBytes, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";

const IS_TESTNET = import.meta.env.VITE_CHAIN === "base-sepolia";
const activeChain = IS_TESTNET ? baseSepolia : base;

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const GIT_ESCROW_ADDRESS = import.meta.env.VITE_GIT_ESCROW_ADDRESS as Address | undefined;

const ESCROW_ABI = parseAbi([
  "function lock(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile) external",
  "function encodeRepoId(string calldata ownerSlashRepo) view returns (bytes32)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);

type Step = 1 | 2 | 3 | 4 | 5 | 6;

type GitHubUser = {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string;
};

type FormState = {
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
    repoFullName: "",
    tokenAddress: import.meta.env.VITE_MOCK_TOKEN_ADDRESS ?? "",
    tokenSymbol: "",
    tokenDecimals: 18,
    tokenBalance: "0",
    lockAmount: "",
    totalPushes: 100,
    pushesPerMilestone: 10,
    chain: IS_TESTNET ? "base-sepolia" : "base",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockTxHash, setLockTxHash] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState<number | null>(null);

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
        setStep(3);
      } catch {
        setError("Failed to parse GitHub user info.");
      }
    }
    if (oauthError) {
      setError(decodeURIComponent(oauthError));
    }
  }, [searchParams]);

  async function connectWallet() {
    if (!(window as Window & { ethereum?: unknown }).ethereum) {
      setError("No wallet detected. Install MetaMask or Coinbase Wallet.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const eth = (window as Window & { ethereum: { request: (args: { method: string; params?: unknown[] }) => Promise<string[]> } }).ethereum;
      const accounts = await eth.request({ method: "eth_requestAccounts" });
      setWallet(accounts[0] as Address);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connect failed");
    } finally {
      setBusy(false);
    }
  }

  function connectGitHub() {
    window.location.href = `${API_BASE}/api/oauth/github`;
  }

  async function loadTokenInfo() {
    if (!form.tokenAddress || !wallet) return;
    setBusy(true);
    setError(null);
    try {
      const client = createPublicClient({ chain: activeChain, transport: http(IS_TESTNET ? "https://sepolia.base.org" : "https://mainnet.base.org") });
      const addr = form.tokenAddress as Address;
      const [symbol, decimals, balance] = await Promise.all([
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" }),
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] }),
      ]);
      setForm((f) => ({
        ...f,
        tokenSymbol: symbol as string,
        tokenDecimals: decimals as number,
        tokenBalance: ((balance as bigint) / BigInt(10 ** (decimals as number))).toString(),
      }));
    } catch (e) {
      setError("Could not load token info — check the address.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLockTokens() {
    console.log("handleLockTokens:", { wallet, GIT_ESCROW_ADDRESS });
    if (!wallet) {
      setError("Connect your wallet first.");
      setBusy(false);
      return;
    }
    if (!GIT_ESCROW_ADDRESS) {
      setError("Escrow contract address not configured: " + JSON.stringify(import.meta.env));
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);

    if (!window.ethereum) {
      setError("MetaMask not detected. Please install MetaMask.");
      setBusy(false);
      return;
    }

    try {
      const rpcUrl = IS_TESTNET ? "https://sepolia.base.org" : "https://mainnet.base.org";
      const publicClient = createPublicClient({ chain: activeChain, transport: http(rpcUrl) });

      const decimals = form.tokenDecimals;
      const amount = BigInt(parseFloat(form.lockAmount) * 10 ** decimals);
      const tokenAddr = form.tokenAddress as Address;

      // Step 1: approve - use MetaMask directly via eth_sendTransaction
      const approveData = "0x095ea7b3000000000000000000000000" + GIT_ESCROW_ADDRESS.slice(2).toLowerCase() + amount.toString(16).padStart(64, "0");
      console.log("Sending approve tx, from:", wallet, "to:", tokenAddr);

      let approveTxHash;
      try {
        approveTxHash = await window.ethereum.request({
          method: "eth_sendTransaction",
          params: [{
            from: wallet,
            to: tokenAddr,
            data: approveData,
          }],
        }) as string;
      } catch (err: any) {
        console.error("Approve tx error:", err);
        setError("MetaMask error: " + (err?.message || err?.code || JSON.stringify(err)));
        setBusy(false);
        return;
      }
      // Skip waiting for receipt - user confirmed in MetaMask, that's enough
      console.log("Approve tx sent:", approveTxHash);

      // Step 2: lock - compute keccak256 of owner/repo for repoId
      const repoIdBytes32 = keccak256(toBytes(form.repoFullName));
      const lockData = "0x7b4e3b9e" + // lock() function selector
        repoIdBytes32.slice(2).padStart(64, "0") +
        tokenAddr.slice(2).padStart(64, "0") +
        amount.toString(16).padStart(64, "0") +
        BigInt(form.totalPushes).toString(16).padStart(64, "0") +
        BigInt(form.pushesPerMilestone).toString(16).padStart(64, "0");

      console.log("Sending lock tx, data:", lockData);
      let lockTxHash;
      try {
        lockTxHash = await window.ethereum.request({
          method: "eth_sendTransaction",
          params: [{
            from: wallet,
            to: GIT_ESCROW_ADDRESS,
            data: lockData,
            value: "0x0",
          }],
        }) as string;
        console.log("Lock tx sent:", lockTxHash);
        setLockTxHash(lockTxHash);
        setStep(6);
      } catch (err: any) {
        console.error("Lock tx error:", err);
        setError("Lock transaction rejected: " + (err?.message || err?.code || "Unknown error"));
        setBusy(false);
        return;
      }
    } catch (e: any) {
      console.error("handleLockTokens error:", e);
      const errMsg = e?.message || e?.reason || JSON.stringify(e);
      setError("Lock transaction failed: " + errMsg);
    } finally {
      setBusy(false);
    }
  }

  async function handleRegister() {
    if (!wallet || !lockTxHash || !installationId || !githubUser) return;
    setBusy(true);
    setError(null);
    try {
      const milestones = form.totalPushes / form.pushesPerMilestone;
      const lockAmountWei = BigInt(parseFloat(form.lockAmount) * 10 ** form.tokenDecimals);
      const tokensPerMilestone = (lockAmountWei / BigInt(milestones)).toString();

      const res = await fetch(`${API_BASE}/api/vesting/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoFullName: form.repoFullName,
          recipient: wallet,
          token: form.tokenAddress,
          chain: form.chain,
          totalLocked: (parseFloat(form.lockAmount) * 10 ** form.tokenDecimals).toString(),
          totalPushesRequired: form.totalPushes,
          pushesPerMilestone: form.pushesPerMilestone,
          tokensPerMilestone,
          onChainTxHash: lockTxHash,
          installationId,
        }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "Registration failed");
      setStep(6);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  const milestonesCount = form.totalPushes > 0 && form.pushesPerMilestone > 0
    ? form.totalPushes / form.pushesPerMilestone
    : 0;
  const tokensPerMilestone = milestonesCount > 0 && form.lockAmount
    ? (parseFloat(form.lockAmount) / milestonesCount).toFixed(2)
    : "—";

  return (
    <div className="vesting-setup-page">
      <header className="vesting-setup-page__header">
        <h1>GitHub Vesting</h1>
        <p className="muted">
          Lock your tokens in escrow — earn them back as you ship code.
          Every {form.pushesPerMilestone} verified pushes to production releases{" "}
          {tokensPerMilestone} {form.tokenSymbol || "tokens"}.
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
          <h2>Step 1 — Connect your wallet</h2>
          <p className="muted">Connect the wallet that is the fee recipient for your token.</p>
          <button className="btn btn-primary" onClick={() => void connectWallet()} disabled={busy}>
            {busy ? "Connecting…" : "Connect Wallet"}
          </button>
        </section>
      )}

      {/* Step 2: Connect GitHub */}
      {step === 2 && (
        <section className="vesting-card">
          <h2>Step 2 — Connect GitHub</h2>
          <p className="muted">
            Wallet connected: <code>{wallet}</code>
          </p>
          <p className="muted">
            We need read access to your repo so our bot can verify your pushes.
          </p>
          <button className="btn btn-primary" onClick={connectGitHub}>
            Connect GitHub →
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
            GitHub repo (owner/repo)
            <input
              type="text"
              placeholder="myorg/my-token-project"
              value={form.repoFullName}
              onChange={(e) => setForm((f) => ({ ...f, repoFullName: e.target.value }))}
            />
          </label>
          <label>
            ERC-20 token address (Base)
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
          <h2>Step 4 — Vesting schedule</h2>
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
          <label>
            Total verified pushes to unlock everything
            <input
              type="number"
              min="10"
              step="10"
              value={form.totalPushes}
              onChange={(e) => setForm((f) => ({ ...f, totalPushes: Number(e.target.value) }))}
            />
          </label>
          <label>
            Release every N pushes (milestone interval)
            <input
              type="number"
              min="1"
              value={form.pushesPerMilestone}
              onChange={(e) =>
                setForm((f) => ({ ...f, pushesPerMilestone: Number(e.target.value) }))
              }
            />
          </label>

          <div className="vesting-preview">
            <p>
              <strong>{milestonesCount} milestones</strong> total ·{" "}
              <strong>{tokensPerMilestone} {form.tokenSymbol}</strong> released per milestone
            </p>
            <p className="muted">
              Every {form.pushesPerMilestone} verified pushes to production →{" "}
              {tokensPerMilestone} {form.tokenSymbol} sent to your wallet automatically.
              At {form.totalPushes} total pushes, all tokens are released.
            </p>
            <p className="muted">
              Anti-spam rules: max 3 counted pushes per day · minimum 30 min between pushes ·
              must have ≥10 lines of real code changed · force-pushes don't count.
            </p>
          </div>

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
            <p className="err small">Total pushes must be divisible by milestone interval.</p>
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
              <strong>Schedule:</strong> {tokensPerMilestone} {form.tokenSymbol} per{" "}
              {form.pushesPerMilestone} verified pushes ({milestonesCount} milestones,{" "}
              {form.totalPushes} total pushes)
            </p>
          </div>
          <p className="muted">
            You will sign 2 transactions: (1) approve escrow, (2) lock tokens.
            Tokens stay in the escrow contract until you reach push milestones.
            You can cancel anytime to reclaim unreleased tokens.
          </p>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void handleLockTokens()}
          >
            {busy ? "Signing transactions…" : "Approve & Lock tokens →"}
          </button>
        </section>
      )}

      {/* Step 6: Install GitHub App + register */}
      {step === 6 && (
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
          <p>
            Install the <strong>Bankr Vesting Bot</strong> GitHub App on your repo so it can
            receive push webhooks and verify your commits.
          </p>
          <a
            href={`https://github.com/apps/bankr-vesting/installations/new`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary"
          >
            Install GitHub App →
          </a>
          <label style={{ marginTop: "1rem" }}>
            GitHub App Installation ID (shown after install)
            <input
              type="number"
              placeholder="12345678"
              value={installationId ?? ""}
              onChange={(e) => setInstallationId(Number(e.target.value))}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={!installationId || busy}
            onClick={() => void handleRegister()}
          >
            {busy ? "Activating…" : "Activate vesting →"}
          </button>
        </section>
      )}

      <style>{`
        .vesting-setup-page { max-width: 600px; margin: 2rem auto; padding: 0 1rem; font-family: system-ui, sans-serif; }
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
      `}</style>
    </div>
  );
}
