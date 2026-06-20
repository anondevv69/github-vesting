import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { shortAddr } from "../lib/format";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type GrantSummary = {
  repoFullName: string;
  githubOwner: string;
  recipient: string;
  status: string;
  totalLockedFormatted: string;
  progress: { verifiedPushCount: number; totalPushesRequired: number; summary: string };
};

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

  return (
    <div className="page">
      <VestingNav />
      <header>
        <h1>Token locks</h1>
        <p className="muted">
          <code>{token}</code>
          {" · "}
          <a href={`https://www.bankr.space/community/${token}`} target="_blank" rel="noreferrer">
            Bankr Space →
          </a>
        </p>
      </header>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="err">{error}</p>}
      {!loading && !error && grants.length === 0 && (
        <p className="muted">No vesting locks on this token yet.</p>
      )}

      <div className="list">
        {grants.map((g) => (
          <article key={g.repoFullName} className="card">
            <h3>
              <Link to={`/vesting/status?repo=${encodeURIComponent(g.repoFullName)}`}>
                {g.repoFullName}
              </Link>
            </h3>
            <p className="muted">
              Dev <Link to={`/vesting/dev/${g.githubOwner}`}>@{g.githubOwner}</Link>
              {" · "}
              Recipient {shortAddr(g.recipient)}
              {" · "}
              {g.status}
            </p>
            <p>
              {g.progress.verifiedPushCount}/{g.progress.totalPushesRequired} verified pushes ·{" "}
              {g.totalLockedFormatted} locked
            </p>
            <p className="muted small">{g.progress.summary}</p>
          </article>
        ))}
      </div>

      <style>{`
        .page { max-width: 760px; margin: 0 auto; padding: 0 1rem 2rem; font-family: system-ui, sans-serif; }
        .muted { color: #6b7280; font-size: 0.9rem; }
        .small { font-size: 0.85rem; }
        .err { color: #dc2626; }
        .list { display: flex; flex-direction: column; gap: 1rem; margin-top: 1rem; }
        .card { border: 1px solid #e5e7eb; border-radius: 0.75rem; padding: 1rem 1.25rem; }
        .card h3 { margin: 0 0 0.35rem; }
        .card a { color: #7c3aed; text-decoration: none; }
        code { background: #f3f4f6; padding: 0.15rem 0.4rem; border-radius: 0.25rem; font-size: 0.8rem; }
      `}</style>
    </div>
  );
}
