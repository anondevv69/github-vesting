import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { DevReputationCard } from "../components/DevReputationCard";
import type { DevReputation } from "../types/reputation";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type GrantSummary = {
  repoFullName: string;
  githubOwner: string;
  token: string;
  status: string;
  totalLockedFormatted: string;
  progress: { verifiedPushCount: number; totalPushesRequired: number; summary: string };
};

type LeaderboardEntry = {
  githubLogin: string;
  reputation: DevReputation;
};

export function VestingExplorePage() {
  const [grants, setGrants] = useState<GrantSummary[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [tokenSearch, setTokenSearch] = useState("");

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/api/vesting/explore`).then((r) => r.json()),
      fetch(`${API_BASE}/api/vesting/leaderboard?limit=10`).then((r) => r.json()),
    ])
      .then(([explore, lb]) => {
        setGrants((explore as { grants?: GrantSummary[] }).grants ?? []);
        setLeaderboard((lb as { leaderboard?: LeaderboardEntry[] }).leaderboard ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page">
      <VestingNav />
      <header>
        <h1>Explore vesting locks</h1>
        <p className="muted">
          Developers earn reputation by locking tokens, shipping verified pushes, and earning community reviews.
        </p>
      </header>

      <label className="search">
        Look up token
        <input
          type="text"
          placeholder="0x… token address"
          value={tokenSearch}
          onChange={(e) => setTokenSearch(e.target.value)}
        />
        {/^0x[a-fA-F0-9]{40}$/.test(tokenSearch.trim()) && (
          <Link to={`/vesting/token/${tokenSearch.trim()}`} className="btn-link">
            View locks on this token →
          </Link>
        )}
      </label>

      {loading && <p className="muted">Loading…</p>}

      {!loading && leaderboard.length > 1 && (
        <section className="leaderboard">
          <h2>Top developers</h2>
          <p className="muted">Ranked by shipping + commitment + community trust.</p>
          <div className="leaderboard-list">
            {leaderboard.map((entry, i) => (
              <Link
                key={entry.githubLogin}
                to={`/vesting/dev/${entry.githubLogin}`}
                className="leaderboard-row"
              >
                <span className="rank">#{i + 1}</span>
                <img
                  src={`https://github.com/${entry.githubLogin}.png?size=40`}
                  alt=""
                  width={36}
                  height={36}
                  className="avatar"
                />
                <div className="leaderboard-meta">
                  <strong>@{entry.githubLogin}</strong>
                  <span className="muted">
                    Lv.{entry.reputation.level} {entry.reputation.title} · {entry.reputation.score} rep
                  </span>
                </div>
                <span className="leaderboard-badges">
                  {entry.reputation.badges.slice(0, 3).map((b) => (
                    <span key={b.id} title={b.description}>{b.icon}</span>
                  ))}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {!loading && leaderboard.length === 1 && (
        <section className="leaderboard">
          <h2>Featured developer</h2>
          <Link to={`/vesting/dev/${leaderboard[0]!.githubLogin}`} className="featured-link">
            <DevReputationCard
              githubLogin={leaderboard[0]!.githubLogin}
              reputation={leaderboard[0]!.reputation}
            />
          </Link>
        </section>
      )}

      <h2>All locks</h2>
      {!loading && grants.length === 0 && <p className="muted">No public locks yet.</p>}

      <div className="list">
        {grants.map((g) => (
          <article key={g.repoFullName} className="card">
            <h3>
              <Link to={`/vesting/status?repo=${encodeURIComponent(g.repoFullName)}`}>
                {g.repoFullName}
              </Link>
            </h3>
            <p className="muted">
              Dev{" "}
              <Link to={`/vesting/dev/${g.githubOwner}`}>@{g.githubOwner}</Link>
              {" · "}
              Token{" "}
              <Link to={`/vesting/token/${g.token}`}>{g.token.slice(0, 6)}…</Link>
              {" · "}
              <span className={`badge ${g.status}`}>{g.status}</span>
            </p>
            <p>
              {g.progress.verifiedPushCount}/{g.progress.totalPushesRequired} pushes ·{" "}
              {g.totalLockedFormatted} locked
            </p>
            <p className="muted small">{g.progress.summary}</p>
          </article>
        ))}
      </div>

      <style>{`
        .page { max-width: 760px; margin: 0 auto; padding: 0 1rem 2rem; font-family: system-ui, sans-serif; }
        .muted { color: #6b7280; }
        .small { font-size: 0.85rem; }
        .search { display: flex; flex-direction: column; gap: 0.5rem; margin: 1.25rem 0; }
        .search input { padding: 0.5rem; border-radius: 0.5rem; border: 1px solid #d1d5db; }
        .btn-link { color: #7c3aed; font-size: 0.9rem; text-decoration: none; }
        .leaderboard { margin-bottom: 2rem; }
        .leaderboard h2 { font-size: 1.05rem; margin-bottom: 0.35rem; }
        .leaderboard-list { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem; }
        .leaderboard-row {
          display: flex; align-items: center; gap: 0.75rem;
          padding: 0.65rem 0.85rem; border: 1px solid #e5e7eb; border-radius: 0.65rem;
          text-decoration: none; color: inherit; transition: border-color 0.15s;
        }
        .leaderboard-row:hover { border-color: #7c3aed; }
        .rank { font-weight: 700; color: #7c3aed; min-width: 2rem; }
        .avatar { border-radius: 9999px; }
        .leaderboard-meta { flex: 1; display: flex; flex-direction: column; gap: 0.1rem; }
        .leaderboard-meta strong { font-size: 0.95rem; }
        .leaderboard-badges { font-size: 1.1rem; }
        .featured-link { text-decoration: none; color: inherit; display: block; }
        .list { display: flex; flex-direction: column; gap: 1rem; }
        .card { border: 1px solid #e5e7eb; border-radius: 0.75rem; padding: 1rem 1.25rem; }
        .card h3 { margin: 0 0 0.35rem; font-size: 1.05rem; }
        .card a { color: #7c3aed; text-decoration: none; }
        .badge { font-size: 0.65rem; padding: 0.1rem 0.45rem; border-radius: 9999px; text-transform: uppercase; font-weight: 600; }
        .badge.active { background: #d1fae5; color: #065f46; }
        .badge.complete { background: #dbeafe; color: #1e40af; }
      `}</style>
    </div>
  );
}
