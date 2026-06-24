import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { CopyButton } from "../components/CopyButton";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const IS_TESTNET = import.meta.env.VITE_CHAIN === "base-sepolia";
const explorerBase = IS_TESTNET ? "https://sepolia.basescan.org" : "https://basescan.org";

type GrantSummary = {
  repoFullName: string;
  githubOwner: string;
  recipient: string;
  status: string;
  totalLocked: string;
  totalLockedFormatted: string;
  createdAt: string;
  progress: {
    verifiedPushCount: number;
    totalPushesRequired: number;
    progressPct?: number;
  };
};

function parseLocked(wei: string): number {
  return Number(wei) / 1e18;
}

export function VestingTokenPage() {
  const { token = "" } = useParams();
  const [grants, setGrants] = useState<GrantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${API_BASE}/api/vesting/by-token/${token}`)
      .then((r) => r.json() as Promise<{ ok: boolean; grants?: GrantSummary[]; error?: string }>)
      .then((d) => {
        if (!d.ok) throw new Error(d.error ?? "Not found");
        setGrants(d.grants ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [token]);

  const stats = useMemo(() => {
    const totalLocked = grants.reduce((s, g) => s + parseLocked(g.totalLocked), 0);
    const activeCount = grants.filter((g) => g.status === "active").length;
    const devs = new Set(grants.map((g) => g.githubOwner));
    const fmt = (n: number) =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` :
      n >= 1_000 ? `${(n / 1_000).toFixed(2)}k` :
      n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return {
      totalLocked: fmt(totalLocked),
      totalReleased: "—",
      activeCount,
      uniqueDevs: devs.size,
    };
  }, [grants]);

  const sorted = useMemo(
    () => [...grants].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [grants],
  );

  return (
    <div className="vesting-page vesting-page--wide">
      <VestingNav />

      <header className="token-header">
        <h1>Token overview</h1>
      </header>

      <div className="token-header">
        <code className="token-header__addr">{token}</code>
        <CopyButton text={token} />
        <a href={`${explorerBase}/address/${token}`} target="_blank" rel="noreferrer">
          Basescan →
        </a>
        <a href={`https://www.bankr.space/community/${token}`} target="_blank" rel="noreferrer">
          Bankr Space →
        </a>
      </div>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="err">{error}</p>}

      {!loading && !error && (
        <>
          <div className="stat-bar">
            <div className="stat-bar__cell">
              <span className="stat-bar__label">Total locked</span>
              <span className="stat-bar__value">{stats.totalLocked}</span>
            </div>
            <div className="stat-bar__cell">
              <span className="stat-bar__label">Total released</span>
              <span className="stat-bar__value">{stats.totalReleased}</span>
            </div>
            <div className="stat-bar__cell">
              <span className="stat-bar__label">Active locks</span>
              <span className="stat-bar__value">{stats.activeCount}</span>
            </div>
            <div className="stat-bar__cell">
              <span className="stat-bar__label">Developers</span>
              <span className="stat-bar__value">{stats.uniqueDevs}</span>
            </div>
          </div>

          {grants.length === 0 ? (
            <p className="muted">No vesting locks on this token yet.</p>
          ) : (
            <table className="locks-table">
              <thead>
                <tr>
                  <th>Developer</th>
                  <th>Repo</th>
                  <th>Locked</th>
                  <th>Progress</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((g) => {
                  const pct = g.progress.totalPushesRequired > 0
                    ? Math.floor((g.progress.verifiedPushCount / g.progress.totalPushesRequired) * 100)
                    : 0;
                  return (
                    <tr key={g.repoFullName}>
                      <td>
                        <Link to={`/vesting/dev/${g.githubOwner}`}>@{g.githubOwner}</Link>
                      </td>
                      <td>
                        <Link to={`/vesting/status?repo=${encodeURIComponent(g.repoFullName)}`}>
                          {g.repoFullName}
                        </Link>
                      </td>
                      <td>{g.totalLockedFormatted}</td>
                      <td>
                        <span className="mini-bar">
                          <span className="mini-bar__fill" style={{ width: `${pct}%` }} />
                        </span>
                        {g.progress.verifiedPushCount}/{g.progress.totalPushesRequired}
                      </td>
                      <td>
                        <span className={`badge ${g.status}`}>{g.status}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
