import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
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
    <div className="vesting-page">
      <VestingNav />
      <header>
        <h1>Explore</h1>
        <p className="muted">
          Live feed of public vesting locks — progress, devs, and reputation.
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
          <Link to={`/vesting/token/${tokenSearch.trim()}`}>
            View locks on this token →
          </Link>
        )}
      </label>

      {loading && <p className="muted">Loading…</p>}

      {!loading && leaderboard.length > 1 && (
        <section className="leaderboard">
          <h2>Top developers</h2>
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

      <h2>All locks</h2>
      {!loading && grants.length === 0 && <p className="muted">No public locks yet.</p>}

      <div className="list">
        {grants.map((g) => {
          const pct = g.progress.totalPushesRequired > 0
            ? Math.floor((g.progress.verifiedPushCount / g.progress.totalPushesRequired) * 100)
            : 0;
          return (
            <article key={g.repoFullName} className="card">
              <h3 style={{ margin: "0 0 0.35rem", fontSize: "0.9375rem" }}>
                <Link to={`/vesting/status?repo=${encodeURIComponent(g.repoFullName)}`}>
                  {g.repoFullName}
                </Link>
              </h3>
              <p className="muted" style={{ fontSize: "0.8125rem", margin: "0 0 0.5rem" }}>
                Dev{" "}
                <Link to={`/vesting/dev/${g.githubOwner}`}>@{g.githubOwner}</Link>
                {" · "}
                Token{" "}
                <Link to={`/vesting/token/${g.token}`}>{g.token.slice(0, 6)}…</Link>
                {" · "}
                <span className={`badge ${g.status}`}>{g.status}</span>
              </p>
              <div className="bar-outer" style={{ marginBottom: "0.35rem" }}>
                <div className="bar-inner" style={{ width: `${pct}%` }} />
              </div>
              <p className="progress-label">
                {g.progress.verifiedPushCount}/{g.progress.totalPushesRequired} pushes ·{" "}
                {g.totalLockedFormatted} locked
              </p>
            </article>
          );
        })}
      </div>
    </div>
  );
}
