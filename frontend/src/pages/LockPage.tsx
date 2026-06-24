import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { CopyButton } from "../components/CopyButton";
import { formatTokens } from "../lib/format";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const IS_TESTNET = import.meta.env.VITE_CHAIN === "base-sepolia";
const explorerBase = IS_TESTNET ? "https://sepolia.basescan.org" : "https://basescan.org";

type LockResponse = {
  ok: boolean;
  grant: {
    repoFullName: string;
    token: string;
    chain: string;
    totalLocked: string;
    status: string;
    onChainTxHash: string;
    totalPushesRequired: number;
    tokensPerMilestone: string;
    lastPaidMilestone: number;
  };
  progress: {
    verifiedPushCount: number;
    totalPushesRequired: number;
    pushesUntilNextRelease: number;
    milestonesCompleted: number;
    totalMilestones: number;
  };
  githubOwner: string;
  releasedFormatted: string;
  remainingFormatted: string;
  recentPushes: Array<{
    ts: number;
    sha: string;
    branch: string;
    linesEstimate?: number;
    commitCount?: number;
    accepted?: boolean;
  }>;
  tokenHolders: Array<{
    wallet: string;
    dev: string;
    repoFullName: string;
    amountFormatted: string;
    pct: number;
    devHref: string;
    href: string;
  }>;
};

function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

export function LockPage() {
  const { owner = "", repoName = "" } = useParams();
  const repoFullName = owner && repoName ? `${owner}/${repoName}` : "";
  const [data, setData] = useState<LockResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoFullName) return;
    setLoading(true);
    fetch(`${API_BASE}/api/vesting/lock/${owner}/${repoName}`)
      .then((r) => r.json() as Promise<LockResponse & { error?: string }>)
      .then((d) => {
        if (!d.ok) throw new Error(d.error ?? "Not found");
        setData(d);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [repoFullName, owner, repoName]);

  if (!repoFullName) {
    return (
      <div className="vesting-page">
        <VestingNav />
        <p className="err">Invalid lock URL</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="vesting-page">
        <VestingNav />
        <p className="muted">Loading lock…</p>
      </div>
    );
  }

  if (error || !data?.ok) {
    return (
      <div className="vesting-page">
        <VestingNav />
        <p className="err">{error ?? "Lock not found"}</p>
      </div>
    );
  }

  const { grant, progress, githubOwner, recentPushes, tokenHolders } = data;
  const verified = recentPushes.filter((p) => p.accepted !== false);
  const pct = progress.totalPushesRequired > 0
    ? Math.floor((progress.verifiedPushCount / progress.totalPushesRequired) * 100)
    : 0;

  return (
    <div className="vesting-page vesting-page--wide">
      <VestingNav />

      <header className="lock-header">
        <div className="lock-header__main">
          <h1 className="lock-header__repo">{grant.repoFullName}</h1>
          <div className="lock-header__meta">
            <img
              src={`https://github.com/${githubOwner}.png?size=64`}
              alt=""
              width={28}
              height={28}
              className="lock-header__avatar"
            />
            <Link to={`/dev/${githubOwner}`}>@{githubOwner}</Link>
            <span className={`badge ${grant.status}`}>{grant.status}</span>
            <span className="chain-badge">{grant.chain}</span>
          </div>
        </div>
      </header>

      <div className="stat-bar lock-stat-bar">
        <div className="stat-bar__cell">
          <span className="stat-bar__label">Locked</span>
          <span className="stat-bar__value stat-bar__value--white">{formatTokens(grant.totalLocked)}</span>
        </div>
        <div className="stat-bar__cell">
          <span className="stat-bar__label">Released</span>
          <span className="stat-bar__value stat-bar__value--green">{data.releasedFormatted}</span>
        </div>
        <div className="stat-bar__cell">
          <span className="stat-bar__label">Verified pushes</span>
          <span className="stat-bar__value">{progress.verifiedPushCount}</span>
        </div>
        <div className="stat-bar__cell">
          <span className="stat-bar__label">To next milestone</span>
          <span className="stat-bar__value">{progress.pushesUntilNextRelease}</span>
        </div>
      </div>

      <div className="bar-outer" style={{ marginBottom: "1.5rem" }}>
        <div className="bar-inner" style={{ width: `${pct}%` }} />
      </div>

      <section className="token-section">
        <h2>Token</h2>
        <div className="token-section__addr">
          <code>{grant.token}</code>
          <CopyButton text={grant.token} />
          <a href={`${explorerBase}/address/${grant.token}`} target="_blank" rel="noreferrer">
            Basescan →
          </a>
        </div>
        {tokenHolders.length > 0 && (
          <table className="locks-table">
            <thead>
              <tr>
                <th>Developer</th>
                <th>Repo</th>
                <th>Locked</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {tokenHolders.map((h) => (
                <tr key={h.repoFullName}>
                  <td><Link to={h.devHref}>@{h.dev}</Link></td>
                  <td>
                    <Link to={h.href}>{h.repoFullName}</Link>
                  </td>
                  <td>{h.amountFormatted}</td>
                  <td>{h.pct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Push timeline</h2>
        {verified.length === 0 ? (
          <p className="muted">No verified pushes yet.</p>
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
                  {p.commitCount ?? 1} file{(p.commitCount ?? 1) === 1 ? "" : "s"}
                  {" · ~"}
                  {p.linesEstimate ?? "—"} lines
                </span>
                <span className="badge-verified">verified</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="muted" style={{ marginTop: "2rem" }}>
        Lock tx{" "}
        <a href={`${explorerBase}/tx/${grant.onChainTxHash}`} target="_blank" rel="noreferrer">
          {grant.onChainTxHash.slice(0, 10)}…
        </a>
        {" · "}
        {data.remainingFormatted} remaining
      </p>
    </div>
  );
}
