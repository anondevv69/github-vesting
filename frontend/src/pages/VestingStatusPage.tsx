/**
 * VestingStatusPage — shows real-time progress for a vesting grant.
 * Access: /vesting/status?repo=owner/repo
 */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { VestingPathChart } from "../components/VestingPathChart";
import { formatTokens } from "../lib/format";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const IS_TESTNET = import.meta.env.VITE_CHAIN === "base-sepolia";
const explorerBase = IS_TESTNET ? "https://sepolia.basescan.org" : "https://basescan.org";

type StatusResponse = {
  ok: boolean;
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
    onChainTxHash: string;
    createdAt: string;
  };
  progress: {
    verifiedPushCount: number;
    totalPushesRequired: number;
    progressPct: number;
    nextMilestoneAt: number | null;
    milestonesCompleted: number;
    totalMilestones: number;
    pushesUntilNextRelease: number;
    summary?: string;
  };
  recentPushes: Array<{
    ts: number;
    sha: string;
    branch: string;
    pusher: string;
    reason: string;
    linesEstimate: number;
  }>;
};

function dedupePushes<T extends { sha: string }>(pushes: T[]): T[] {
  const seen = new Set<string>();
  return pushes.filter((p) => {
    if (seen.has(p.sha)) return false;
    seen.add(p.sha);
    return true;
  });
}

export function VestingStatusPage() {
  const [searchParams] = useSearchParams();
  const repo = searchParams.get("repo") ?? "";
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    setLoading(true);
    fetch(`${API_BASE}/api/vesting/status?repo=${encodeURIComponent(repo)}`)
      .then((r) => r.json() as Promise<StatusResponse>)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [repo]);

  if (!repo) {
    return <div className="vesting-status">Enter <code>?repo=owner/repo</code> in the URL.</div>;
  }

  if (loading) return <div className="vesting-status"><p>Loading…</p></div>;
  if (error || !data?.ok) return <div className="vesting-status"><p className="err">{error ?? data?.grant?.repoFullName ?? "Not found"}</p></div>;

  const { grant, progress, recentPushes } = data;
  const barWidth = `${progress.progressPct}%`;
  const owner = grant.repoFullName.split("/")[0] ?? "";
  const uniquePushes = dedupePushes(recentPushes);

  return (
    <div className="vesting-status">
      <VestingNav />
      <h1>
        {grant.repoFullName}
        <span className={`status-badge ${grant.status}`}>{grant.status}</span>
      </h1>
      <p className="muted">
        Dev <Link to={`/vesting/dev/${owner}`}>@{owner}</Link>
        {" · "}
        Token <Link to={`/vesting/token/${grant.token}`}>{grant.token.slice(0, 6)}…</Link>
        {" · "}
        Recipient: <code>{grant.recipient.slice(0, 6)}…{grant.recipient.slice(-4)}</code>
        {" · "}Chain: {grant.chain}
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

      <div className="progress-bar-outer">
        <div className="progress-bar-inner" style={{ width: barWidth }} />
      </div>
      <p className="progress-label">
        <strong>{progress.verifiedPushCount} / {progress.totalPushesRequired}</strong> verified pushes ({progress.progressPct}%)
      </p>

      <div className="stats-grid">
        <div className="stat">
          <div className="stat-value">{progress.milestonesCompleted}/{progress.totalMilestones}</div>
          <div className="stat-label">milestones paid</div>
        </div>
        <div className="stat">
          <div className="stat-value">{progress.pushesUntilNextRelease}</div>
          <div className="stat-label">pushes until next release</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatTokens(grant.tokensPerMilestone)}</div>
          <div className="stat-label">tokens per release</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatTokens(grant.totalLocked)}</div>
          <div className="stat-label">total locked</div>
        </div>
      </div>

      <h2>Recent verified pushes</h2>
      {recentPushes.length === 0 ? (
        <p className="muted">No verified pushes yet.</p>
      ) : (
        <table className="pushes-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Pusher</th>
              <th>Branch</th>
              <th>Lines ~</th>
              <th>Commit</th>
            </tr>
          </thead>
          <tbody>
            {uniquePushes.reverse().map((p) => (
              <tr key={p.sha}>
                <td>{new Date(p.ts).toLocaleString()}</td>
                <td>@{p.pusher}</td>
                <td><code>{p.branch}</code></td>
                <td>{p.linesEstimate}</td>
                <td>
                  <a href={`https://github.com/${grant.repoFullName}/commit/${p.sha}`} target="_blank" rel="noreferrer">
                    {p.sha.slice(0, 7)}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="muted" style={{ marginTop: "2rem" }}>
        Lock tx:{" "}
        <a href={`${explorerBase}/tx/${grant.onChainTxHash}`} target="_blank" rel="noreferrer">
          {grant.onChainTxHash.slice(0, 10)}…
        </a>
        {" · "}Started {new Date(grant.createdAt).toLocaleDateString()}
      </p>

      <style>{`
        .vesting-status { max-width: 700px; margin: 2rem auto; padding: 0 1rem; font-family: system-ui, sans-serif; }
        h1 { display: flex; align-items: center; gap: 0.75rem; }
        .status-badge { font-size: 0.75rem; padding: 0.2rem 0.6rem; border-radius: 9999px; font-weight: 600; text-transform: uppercase; }
        .status-badge.active { background: #d1fae5; color: #065f46; }
        .status-badge.complete { background: #dbeafe; color: #1e40af; }
        .status-badge.cancelled { background: #fee2e2; color: #991b1b; }
        .progress-bar-outer { background: #e5e7eb; border-radius: 9999px; height: 1.2rem; margin: 1rem 0 0.4rem; overflow: hidden; }
        .progress-bar-inner { background: #7c3aed; height: 100%; border-radius: 9999px; transition: width 0.4s ease; }
        .progress-label { font-size: 0.9rem; color: #374151; }
        .stats-grid { display: flex; gap: 1.5rem; margin: 1.5rem 0; flex-wrap: wrap; }
        .stat { background: #f9fafb; border-radius: 0.5rem; padding: 0.75rem 1.25rem; min-width: 120px; }
        .stat-value { font-size: 1.4rem; font-weight: 700; }
        .stat-label { font-size: 0.8rem; color: #6b7280; }
        .pushes-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
        .pushes-table th { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #e5e7eb; color: #6b7280; }
        .pushes-table td { padding: 0.5rem; border-bottom: 1px solid #f3f4f6; }
        .schedule-summary { font-size: 0.95rem; color: #374151; margin: 0.75rem 0; }
        .vesting-status a { color: #7c3aed; text-decoration: none; }
        .err { color: #dc2626; }
        code { background: #f3f4f6; padding: 0.2rem 0.4rem; border-radius: 0.25rem; font-size: 0.8rem; }
      `}</style>
    </div>
  );
}
