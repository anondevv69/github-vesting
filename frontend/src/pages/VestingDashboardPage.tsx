/**
 * VestingDashboardPage — connect wallet to see all your vesting locks.
 */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Address } from "viem";
import { VestingNav } from "../components/VestingNav";
import { VestingPathChart } from "../components/VestingPathChart";
import { formatTokens } from "../lib/format";

type GitHubUser = {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string;
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
    singleRelease?: boolean;
  };
  recentPushes: Array<{ ts: number; sha: string; branch: string; pusher: string; reason: string }>;
};

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const IS_TESTNET = import.meta.env.VITE_CHAIN === "base-sepolia";
const explorerBase = IS_TESTNET ? "https://sepolia.basescan.org" : "https://basescan.org";

function dedupePushes<T extends { sha: string }>(pushes: T[]): T[] {
  const seen = new Set<string>();
  return pushes.filter((p) => {
    if (seen.has(p.sha)) return false;
    seen.add(p.sha);
    return true;
  });
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
    window.location.href = `${API_BASE}/api/oauth/github`;
  }

  return (
    <div className="vesting-dashboard">
      <VestingNav />
      <header>
        <h1>My Vesting Locks</h1>
        <p className="muted">
          Connect your wallet to see repos you&apos;ve locked tokens on and track push progress.
        </p>
      </header>

      <section className="connect-row">
        <button className="btn" onClick={() => void connectWallet()} disabled={!!wallet}>
          {wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Connect wallet"}
        </button>
        <button className="btn" onClick={connectGitHub}>
          {githubUser ? `@${githubUser.login}` : "Connect GitHub"}
        </button>
      </section>

      <section className="help-box">
        <h2>What counts?</h2>
        <p><strong>Verified push</strong> = one real push to <code>main</code> with ≥50 lines of code (not docs/lockfiles). Same commit never counts twice.</p>
        <p><strong>Your schedule</strong> sets how many verified pushes unlock tokens. Multiple pushes can feed <em>one</em> release (not one payout per push unless you configured it that way).</p>
        <p className="example">
          Example: <strong>2 pushes required, release every 2</strong> → <strong>1 payout</strong> with <strong>all tokens</strong> after 2 verified pushes (not 2 separate payouts).
        </p>
      </section>

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
          const uniquePushes = dedupePushes(recentPushes);
          return (
          <article key={grant.repoFullName} className="grant-card">
            <div className="grant-card__head">
              <h3>{grant.repoFullName}</h3>
              <span className={`badge ${grant.status}`}>{grant.status}</span>
            </div>
            <p className="muted">
              Dev <Link to={`/vesting/dev/${owner}`}>@{owner}</Link>
              {" · "}
              {grant.streaming ? "Streaming (tokens in your wallet)" : "Pre-funded (tokens in escrow)"}
              {" · "}{grant.chain}
            </p>

            {progress.summary && <p className="schedule-summary">{progress.summary}</p>}

            <VestingPathChart
              totalPushes={grant.totalPushesRequired}
              pushesPerMilestone={grant.pushesPerMilestone}
              tokensPerMilestone={grant.tokensPerMilestone}
              tokenSymbol="tokens"
              verifiedPushCount={progress.verifiedPushCount}
              milestonesPaid={progress.milestonesCompleted}
            />

            <div className="bar-outer">
              <div className="bar-inner" style={{ width: `${progress.progressPct}%` }} />
            </div>
            <p>
              <strong>{progress.verifiedPushCount} / {progress.totalPushesRequired}</strong> verified pushes
              {" · "}
              <strong>{progress.pushesUntilNextRelease}</strong> until next release
            </p>
            <p className="muted">
              Milestones: {progress.milestonesCompleted}/{progress.totalMilestones} paid
              {" · "}
              {formatTokens(grant.tokensPerMilestone)} tokens per milestone
              {" · "}
              {formatTokens(grant.totalLocked)} total locked
            </p>

            {uniquePushes.length > 0 && (
              <ul className="recent">
                {uniquePushes.map((p) => (
                  <li key={p.sha}>
                    {new Date(p.ts).toLocaleString()} — {p.reason}
                  </li>
                ))}
              </ul>
            )}

            <div className="grant-card__links">
              <Link to={`/vesting/status?repo=${encodeURIComponent(grant.repoFullName)}`}>
                Full details →
              </Link>
              <Link to={`/vesting/token/${grant.token}`}>Token locks</Link>
              <a href={`${explorerBase}/tx/${grant.onChainTxHash}`} target="_blank" rel="noreferrer">
                Lock tx
              </a>
            </div>
          </article>
          );
        })}
      </div>

      <style>{`
        .vesting-dashboard { max-width: 720px; margin: 2rem auto; padding: 0 1rem; font-family: system-ui, sans-serif; }
        .muted { color: #6b7280; font-size: 0.9rem; }
        .err { color: #dc2626; }
        .schedule-summary { font-size: 0.9rem; color: #374151; margin: 0.5rem 0; }
        .connect-row { display: flex; gap: 0.75rem; margin: 1.25rem 0; flex-wrap: wrap; }
        .btn { padding: 0.5rem 1rem; border-radius: 0.5rem; border: 1px solid #d1d5db; background: #fff; cursor: pointer; }
        .help-box { background: #f9fafb; border-radius: 0.75rem; padding: 1rem 1.25rem; margin-bottom: 1.5rem; font-size: 0.9rem; }
        .help-box h2 { margin: 0 0 0.5rem; font-size: 1rem; }
        .example { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid #e5e7eb; }
        .grant-list { display: flex; flex-direction: column; gap: 1rem; }
        .grant-card { border: 1px solid #e5e7eb; border-radius: 0.75rem; padding: 1.25rem; }
        .grant-card__head { display: flex; align-items: center; gap: 0.75rem; }
        .grant-card__head h3 { margin: 0; font-size: 1.1rem; }
        .badge { font-size: 0.7rem; padding: 0.15rem 0.5rem; border-radius: 9999px; text-transform: uppercase; font-weight: 600; }
        .badge.active { background: #d1fae5; color: #065f46; }
        .badge.complete { background: #dbeafe; color: #1e40af; }
        .badge.cancelled { background: #fee2e2; color: #991b1b; }
        .bar-outer { background: #e5e7eb; border-radius: 9999px; height: 0.75rem; margin: 0.75rem 0 0.4rem; overflow: hidden; }
        .bar-inner { background: #7c3aed; height: 100%; transition: width 0.3s; }
        .recent { margin: 0.75rem 0 0; padding-left: 1.2rem; font-size: 0.8rem; color: #374151; }
        .grant-card__links { display: flex; gap: 1rem; margin-top: 1rem; font-size: 0.875rem; }
        .grant-card__links a { color: #7c3aed; }
        code { background: #f3f4f6; padding: 0.1rem 0.35rem; border-radius: 0.25rem; font-size: 0.85em; }
      `}</style>
    </div>
  );
}
