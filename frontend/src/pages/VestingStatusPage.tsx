/**
 * VestingStatusPage — public read-only progress for a vesting grant.
 */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { CopyButton } from "../components/CopyButton";
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
    milestonesCompleted: number;
    totalMilestones: number;
    summary?: string;
  };
  recentPushes: Array<{
    ts: number;
    sha: string;
    branch: string;
    pusher: string;
    reason: string;
    linesEstimate?: number;
    commitCount?: number;
    accepted?: boolean;
  }>;
};

function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function dedupePushes<T extends { sha: string; accepted?: boolean }>(pushes: T[]): T[] {
  const seen = new Set<string>();
  return pushes.filter((p) => {
    if (p.accepted === false) return true;
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
    return (
      <div className="vesting-page">
        <VestingNav />
        <p className="muted">Enter <code>?repo=owner/repo</code> in the URL.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="vesting-page">
        <VestingNav />
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (error || !data?.ok) {
    return (
      <div className="vesting-page">
        <VestingNav />
        <p className="err">{error ?? "Not found"}</p>
      </div>
    );
  }

  const { grant, progress, recentPushes } = data;
  const owner = grant.repoFullName.split("/")[0] ?? "";
  const verified = dedupePushes(recentPushes.filter((p) => p.accepted !== false));
  const releasedWei =
    BigInt(grant.tokensPerMilestone) * BigInt(grant.lastPaidMilestone);
  const remainingWei = BigInt(grant.totalLocked) - releasedWei;
  const barWidth = `${progress.progressPct}%`;

  return (
    <div className="vesting-page">
      <VestingNav />

      <header className="status-header">
        <img
          src={`https://github.com/${owner}.png?size=112`}
          alt=""
          className="status-header__avatar"
          width={56}
          height={56}
        />
        <div>
          <h1 className="status-header__title">{grant.repoFullName}</h1>
          <p className="status-header__sub muted">
            <Link to={`/vesting/dev/${owner}`}>@{owner}</Link>
            {" · "}
            <span className={`status-badge ${grant.status}`}>{grant.status}</span>
            {" · "}{grant.chain}
          </p>
        </div>
      </header>

      <div className="progress-rail">
        <span className="progress-rail__left">{formatTokens(grant.totalLocked)} locked</span>
        <span className="progress-rail__right">
          {progress.verifiedPushCount} / {progress.totalPushesRequired} pushes
        </span>
      </div>
      <div className="progress-bar-outer">
        <div className="progress-bar-inner" style={{ width: barWidth }} />
      </div>
      <p className="progress-label">
        {progress.milestonesCompleted}/{progress.totalMilestones} milestones paid
        {progress.summary && ` · ${progress.summary}`}
      </p>

      <h2>Verified pushes</h2>
      {verified.length === 0 ? (
        <p className="muted">
          No verified pushes yet. Only pushes to <code>main</code> after{" "}
          {new Date(grant.createdAt).toLocaleString()} count.
        </p>
      ) : (
        <ul className="timeline-feed">
          {[...verified].reverse().map((p) => (
            <li key={p.sha} className="timeline-feed__item">
              <span className="timeline-feed__ts">{formatTs(p.ts)}</span>
              <span className="timeline-feed__sha">
                <a
                  href={`https://github.com/${grant.repoFullName}/commit/${p.sha}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {p.sha.slice(0, 7)}
                </a>
              </span>
              <span>
                {p.commitCount ?? 1} commit{(p.commitCount ?? 1) === 1 ? "" : "s"}
                {" · ~"}
                {p.linesEstimate ?? "—"} lines
                {" · "}
                <code>{p.branch}</code>
              </span>
              <span className="badge-verified">verified</span>
            </li>
          ))}
        </ul>
      )}

      <div className="token-summary">
        <h2>Token summary</h2>
        <div className="token-summary__row">
          <span className="token-summary__label">Contract</span>
          <span className="token-summary__addr">
            <code>{grant.token.slice(0, 6)}…{grant.token.slice(-4)}</code>
            <CopyButton text={grant.token} />
            <Link to={`/vesting/token/${grant.token}`}>View →</Link>
          </span>
        </div>
        <div className="token-summary__row">
          <span className="token-summary__label">Locked</span>
          <span className="token-summary__value">{formatTokens(grant.totalLocked)}</span>
        </div>
        <div className="token-summary__row">
          <span className="token-summary__label">Released</span>
          <span className="token-summary__value">{formatTokens(releasedWei.toString())}</span>
        </div>
        <div className="token-summary__row">
          <span className="token-summary__label">Remaining</span>
          <span className="token-summary__value">{formatTokens(remainingWei.toString())}</span>
        </div>
        <div className="token-summary__row">
          <span className="token-summary__label">Lock tx</span>
          <span>
            <a href={`${explorerBase}/tx/${grant.onChainTxHash}`} target="_blank" rel="noreferrer">
              {grant.onChainTxHash.slice(0, 10)}…
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}
