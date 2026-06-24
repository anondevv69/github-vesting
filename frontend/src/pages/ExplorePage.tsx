import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { VestingFooter } from "../components/VestingFooter";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type SearchResult = {
  type: "dev" | "repo" | "token";
  id: string;
  label: string;
  secondary: string;
  href: string;
};

type RecentPush = {
  ts: number;
  repoFullName: string;
  githubOwner: string;
  sha: string;
  linesEstimate?: number;
  commitCount?: number;
  href: string;
  devHref: string;
};

type ExploreGrant = {
  repoFullName: string;
  githubOwner: string;
  status: string;
  totalLockedFormatted: string;
  createdAt: string;
  progress: {
    verifiedPushCount: number;
    totalPushesRequired: number;
  };
};

function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

function formatCreatedAt(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

function lockPath(repoFullName: string): string {
  const [owner, name] = repoFullName.split("/");
  return `/lock/${owner}/${name}`;
}

export function ExplorePage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [recent, setRecent] = useState<RecentPush[]>([]);
  const [locks, setLocks] = useState<ExploreGrant[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/vesting/explore`)
      .then((r) => r.json() as Promise<{ ok: boolean; grants?: ExploreGrant[] }>)
      .then((d) => setLocks(d.grants ?? []))
      .catch(() => setLocks([]));

    fetch(`${API_BASE}/api/vesting/recent-pushes?limit=10`)
      .then((r) => r.json() as Promise<{ ok: boolean; pushes?: RecentPush[] }>)
      .then((d) => setRecent(d.pushes ?? []))
      .catch(() => setRecent([]));
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      setSearching(true);
      fetch(`${API_BASE}/api/vesting/search?q=${encodeURIComponent(query.trim())}`)
        .then((r) => r.json() as Promise<{ ok: boolean; results?: SearchResult[] }>)
        .then((d) => setResults(d.results ?? []))
        .finally(() => setSearching(false));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const showRecent = !query.trim();

  return (
    <div className="vesting-page vesting-page--wide">
      <VestingNav />

      <div className="search-hero">
        <input
          type="search"
          className="search-hero__input"
          placeholder="search by dev, repo, token name, or address"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      {searching && <p className="muted">Searching…</p>}

      {!showRecent && results.length === 0 && !searching && (
        <p className="muted">No results for &ldquo;{query}&rdquo;</p>
      )}

      {!showRecent && results.length > 0 && (
        <ul className="search-results">
          {results.map((r) => (
            <li key={`${r.type}-${r.id}`}>
              <button
                type="button"
                className="search-results__row"
                onClick={() => navigate(r.href.startsWith("/") ? r.href : lockPath(r.id))}
              >
                <span className={`type-badge type-badge--${r.type}`}>{r.type}</span>
                <span className="search-results__label">{r.label}</span>
                <span className="search-results__secondary muted">{r.secondary}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {showRecent && (
        <>
          <section style={{ marginBottom: "2rem" }}>
            <h2>Recent locks</h2>
            <p className="search-hints muted">
              Newest vesting locks on Proof of Dev — including repos with no pushes yet.
            </p>
            {locks.length === 0 ? (
              <p className="muted">No locks yet.</p>
            ) : (
              <div className="lock-grid">
                {locks.map((g) => {
                  const pct = g.progress.totalPushesRequired > 0
                    ? Math.floor((g.progress.verifiedPushCount / g.progress.totalPushesRequired) * 100)
                    : 0;
                  return (
                    <Link
                      key={g.repoFullName}
                      to={lockPath(g.repoFullName)}
                      className="lock-grid__card lock-grid__card--link"
                    >
                      <p className="lock-grid__repo">{g.repoFullName}</p>
                      <p className="muted" style={{ fontSize: "0.75rem" }}>
                        @{g.githubOwner}
                        {" · "}
                        {g.totalLockedFormatted} locked
                        {" · "}
                        {formatCreatedAt(g.createdAt)}
                      </p>
                      <div className="bar-outer">
                        <div className="bar-inner" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="progress-label">
                        {g.progress.verifiedPushCount}/{g.progress.totalPushesRequired} pushes
                      </p>
                      <span className={`badge ${g.status}`}>{g.status}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <h2>Recently active</h2>
            <p className="search-hints muted">
              Repos with verified pushes on main — search by GitHub username, repo (<code>owner/repo</code>),
              token contract address, or X handle if the dev linked it on their profile.
            </p>
            {recent.length === 0 ? (
              <p className="muted">No verified pushes yet.</p>
            ) : (
              <ul className="recent-feed">
                {recent.map((p) => (
                  <li key={`${p.repoFullName}-${p.sha}`} className="recent-feed__item">
                    <Link to={p.href}>{p.repoFullName}</Link>
                    <span className="muted">
                      <Link to={p.devHref}>@{p.githubOwner}</Link>
                      {" · "}
                      {formatTs(p.ts)}
                      {p.linesEstimate != null && ` · ~${p.linesEstimate} lines`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <VestingFooter />
    </div>
  );
}
