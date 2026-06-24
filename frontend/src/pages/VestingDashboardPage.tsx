/**
 * VestingDashboardPage — connect wallet to see all your vesting locks.
 */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Address } from "viem";
import { VestingNav } from "../components/VestingNav";
import { formatTokens } from "../lib/format";

type GitHubUser = {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string;
};

type PushLogEntry = {
  ts: number;
  sha: string;
  branch: string;
  pusher: string;
  reason: string;
  linesEstimate?: number;
  commitCount?: number;
  accepted?: boolean;
};

type GrantEntry = {
  grant: {
    repoFullName: string;
    recipient: string;
    token: string;
    chain: string;
    totalLocked: string;
    totalPushesRequired: number;
    pushesPerMilestone: number;
    tokensPerMilestone: string;
    verifiedPushCount: number;
    lastPaidMilestone: number;
    status: "active" | "complete" | "cancelled";
    streaming: boolean;
    onChainTxHash: string;
  };
  progress: {
    verifiedPushCount: number;
    totalPushesRequired: number;
    progressPct: number;
    pushesUntilNextRelease: number;
    milestonesCompleted: number;
    totalMilestones: number;
    summary?: string;
  };
  recentPushes: PushLogEntry[];
};

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const IS_TESTNET = import.meta.env.VITE_CHAIN === "base-sepolia";
const explorerBase = IS_TESTNET ? "https://sepolia.basescan.org" : "https://basescan.org";

function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

export function VestingDashboardPage() {
  const [searchParams] = useSearchParams();
  const [wallet, setWallet] = useState<Address | null>(() => {
    const saved = localStorage.getItem("vesting_wallet");
    return saved ? (saved as Address) : null;
  });
  const [githubUser, setGithubUser] = useState<GitHubUser | null>(null);
  const [grants, setGrants] = useState<GrantEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const githubUserParam = searchParams.get("github_user");
    if (githubUserParam) {
      try {
        const user = JSON.parse(decodeURIComponent(githubUserParam)) as GitHubUser;
        setGithubUser(user);
        localStorage.setItem("vesting_github_user", JSON.stringify(user));
      } catch { /* ignore */ }
    } else {
      const saved = localStorage.getItem("vesting_github_user");
      if (saved) setGithubUser(JSON.parse(saved) as GitHubUser);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!wallet) return;
    localStorage.setItem("vesting_wallet", wallet);
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/vesting/grants?recipient=${wallet}`)
      .then((r) => r.json() as Promise<{ ok: boolean; grants?: GrantEntry[]; error?: string }>)
      .then((d) => {
        if (!d.ok) throw new Error(d.error ?? "Failed to load grants");
        setGrants(d.grants ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [wallet]);

  async function connectWallet() {
    const eth = (window as Window & { ethereum?: { request: (args: { method: string }) => Promise<string[]> } }).ethereum;
    if (!eth) {
      setError("MetaMask not detected");
      return;
    }
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    if (accounts[0]) setWallet(accounts[0] as Address);
  }

  function connectGitHub() {
    const returnTo = encodeURIComponent("/vesting/dashboard");
    window.location.href = `${API_BASE}/api/oauth/github?returnTo=${returnTo}`;
  }

  return (
    <div className="vesting-page">
      <VestingNav />
      <header>
        <h1>My locks</h1>
        <p className="muted">Connect wallet to track your vesting grants.</p>
      </header>

      <section className="connect-row">
        <button type="button" className="btn" onClick={() => void connectWallet()} disabled={!!wallet}>
          {wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Connect wallet"}
        </button>
        <button type="button" className="btn" onClick={connectGitHub}>
          {githubUser ? `@${githubUser.login}` : "Connect GitHub"}
        </button>
      </section>

      <details className="drawer">
        <summary>How this works</summary>
        <div className="drawer__body">
          <p>
            <strong>Verified push</strong> = one real push to <code>main</code> with ≥3 lines of code
            (not docs/lockfiles). Same commit never counts twice.
          </p>
          <p>
            <strong>Your schedule</strong> sets how many verified pushes unlock tokens. Multiple pushes
            can feed one release.
          </p>
          <p>
            Example: <strong>2 pushes required, release every 2</strong> → one payout with all tokens
            after 2 verified pushes.
          </p>
        </div>
      </details>

      {error && <p className="err">{error}</p>}
      {loading && <p className="muted">Loading your locks…</p>}

      {!wallet && !loading && (
        <p className="muted">Connect your wallet to view vesting grants.</p>
      )}

      {wallet && !loading && grants.length === 0 && !error && (
        <p className="muted">No vesting locks found for this wallet.</p>
      )}

      <div className="grant-list">
        {grants.map(({ grant, progress, recentPushes }) => {
          const owner = grant.repoFullName.split("/")[0] ?? "";
          const verifiedLog = recentPushes.filter((p) => p.accepted !== false);
          const claimable = grant.status === "complete";
          const claimHint = claimable
            ? "All milestones complete — tokens released"
            : `${progress.pushesUntilNextRelease} push${progress.pushesUntilNextRelease === 1 ? "" : "es"} until next release`;

          return (
            <article key={grant.repoFullName} className="grant-card">
              <div className="grant-card__head">
                <h3>
                  <Link to={`/vesting/status?repo=${encodeURIComponent(grant.repoFullName)}`}>
                    {grant.repoFullName}
                  </Link>
                </h3>
                <span className={`badge ${grant.status}`}>{grant.status}</span>
              </div>

              <div className="meta-strip">
                <div className="meta-strip__cell">
                  <span className="meta-strip__label">Locked</span>
                  <span className="meta-strip__value">{formatTokens(grant.totalLocked)}</span>
                </div>
                <div className="meta-strip__cell">
                  <span className="meta-strip__label">Target</span>
                  <span className="meta-strip__value">{progress.totalPushesRequired} pushes</span>
                </div>
                <div className="meta-strip__cell">
                  <span className="meta-strip__label">Chain</span>
                  <span className="meta-strip__value">{grant.chain}</span>
                </div>
                <div className="meta-strip__cell">
                  <span className="meta-strip__label">Paid</span>
                  <span className="meta-strip__value">
                    {progress.milestonesCompleted}/{progress.totalMilestones}
                  </span>
                </div>
              </div>

              <div className="bar-outer">
                <div className="bar-inner" style={{ width: `${progress.progressPct}%` }} />
              </div>
              <p className="progress-label">
                <strong>{progress.verifiedPushCount} / {progress.totalPushesRequired}</strong> verified pushes
              </p>

              {verifiedLog.length > 0 && (
                <table className="pushes-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Commits</th>
                      <th>Lines</th>
                      <th>Branch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...verifiedLog].reverse().slice(0, 5).map((p) => (
                      <tr key={p.sha}>
                        <td>{formatTs(p.ts)}</td>
                        <td>{p.commitCount ?? 1}</td>
                        <td>{p.linesEstimate ?? "—"}</td>
                        <td>
                          <a
                            href={`https://github.com/${grant.repoFullName}/commit/${p.sha}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <code>{p.branch}</code>
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="grant-card__links">
                <Link to={`/vesting/dev/${owner}`}>@{owner}</Link>
                <Link to={`/vesting/token/${grant.token}`}>Token</Link>
                <a href={`${explorerBase}/tx/${grant.onChainTxHash}`} target="_blank" rel="noreferrer">
                  Lock tx
                </a>
              </div>

              <div className="grant-card__footer">
                <button
                  type="button"
                  className="btn btn-green"
                  disabled={!claimable}
                  title={claimHint}
                >
                  {claimable ? "Tokens released" : "Claim tokens"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
