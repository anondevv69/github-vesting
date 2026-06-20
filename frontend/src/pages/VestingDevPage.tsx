import { useEffect, useState, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import type { Address } from "viem";
import { VestingNav } from "../components/VestingNav";
import { DevReputationCard } from "../components/DevReputationCard";
import { shortAddr } from "../lib/format";
import type { DevReputation } from "../types/reputation";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type GrantSummary = {
  repoFullName: string;
  token: string;
  status: string;
  totalLockedFormatted: string;
  progress: {
    verifiedPushCount: number;
    totalPushesRequired: number;
    summary: string;
    milestonesCompleted: number;
    totalMilestones: number;
  };
};

type Review = {
  wallet: string;
  rating: number;
  comment: string;
  createdAt: string;
};

export function VestingDevPage() {
  const { login = "" } = useParams();
  const [grants, setGrants] = useState<GrantSummary[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reputation, setReputation] = useState<DevReputation | null>(null);
  const [communityUrl, setCommunityUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [wallet, setWallet] = useState<Address | null>(null);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadDev = useCallback(() => {
    if (!login) return;
    setLoading(true);
    fetch(`${API_BASE}/api/vesting/by-dev/${login}`)
      .then((r) => r.json() as Promise<{
        ok: boolean;
        grants?: GrantSummary[];
        reviews?: Review[];
        reputation?: DevReputation;
        communityUrl?: string | null;
      }>)
      .then((d) => {
        setGrants(d.grants ?? []);
        setReviews(d.reviews ?? []);
        setReputation(d.reputation ?? null);
        setCommunityUrl(d.communityUrl ?? null);
      })
      .finally(() => setLoading(false));
  }, [login]);

  useEffect(() => {
    loadDev();
  }, [loadDev]);

  async function connectWallet() {
    const eth = (window as Window & { ethereum?: { request: (a: { method: string }) => Promise<string[]> } }).ethereum;
    if (!eth) return;
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    if (accounts[0]) setWallet(accounts[0] as Address);
  }

  async function submitReview(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet) {
      await connectWallet();
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/vesting/by-dev/${login}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wallet-address": wallet },
        body: JSON.stringify({ wallet, rating, comment }),
      });
      const d = await res.json() as { ok: boolean; error?: string };
      if (!d.ok) throw new Error(d.error ?? "Failed");
      setComment("");
      loadDev();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to post review");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <VestingNav />
      <header className="dev-header">
        <img
          src={`https://github.com/${login}.png?size=80`}
          alt=""
          className="avatar"
          width={64}
          height={64}
        />
        <div>
          <h1>@{login}</h1>
          <p className="muted header-sub">
            {reputation?.title ?? "Developer"}
            {reputation && ` · Level ${reputation.level} · ${reputation.score} rep`}
          </p>
          <a href={`https://github.com/${login}`} target="_blank" rel="noreferrer" className="link">
            GitHub profile →
          </a>
          {communityUrl && (
            <a href={communityUrl} target="_blank" rel="noreferrer" className="link">
              Bankr Space →
            </a>
          )}
        </div>
      </header>

      {loading && <p className="muted">Loading developer profile…</p>}

      {!loading && reputation && (
        <DevReputationCard githubLogin={login} reputation={reputation} />
      )}

      {!loading && reputation?.stats && (
        <section className="timeline">
          <h2>Building reputation over time</h2>
          <ul>
            {reputation.stats.firstLockAt && (
              <li>
                <span className="timeline-dot" />
                <div>
                  <strong>First vesting lock</strong>
                  <p className="muted">{new Date(reputation.stats.firstLockAt).toLocaleDateString()}</p>
                </div>
              </li>
            )}
            {reputation.stats.lastPushAt && (
              <li>
                <span className="timeline-dot active" />
                <div>
                  <strong>Last verified push</strong>
                  <p className="muted">{new Date(reputation.stats.lastPushAt).toLocaleString()}</p>
                </div>
              </li>
            )}
            {reputation.stats.reviewCount > 0 && (
              <li>
                <span className="timeline-dot community" />
                <div>
                  <strong>Community trust</strong>
                  <p className="muted">
                    {reputation.stats.avgRating?.toFixed(1)} ★ from {reputation.stats.reviewCount} review
                    {reputation.stats.reviewCount === 1 ? "" : "s"}
                  </p>
                </div>
              </li>
            )}
            {reputation.stats.completedLocks > 0 && (
              <li>
                <span className="timeline-dot complete" />
                <div>
                  <strong>Vesting milestones hit</strong>
                  <p className="muted">
                    {reputation.stats.completedLocks} schedule
                    {reputation.stats.completedLocks === 1 ? "" : "s"} completed ·{" "}
                    {reputation.stats.milestonesPaid} on-chain releases
                  </p>
                </div>
              </li>
            )}
          </ul>
        </section>
      )}

      <h2>Locked repos</h2>
      {!loading && grants.length === 0 && (
        <p className="muted">No public vesting locks for this developer yet.</p>
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
              <Link to={`/vesting/token/${g.token}`}>Token {shortAddr(g.token)}</Link>
              {" · "}{g.status}
            </p>
            <p>
              {g.progress.verifiedPushCount}/{g.progress.totalPushesRequired} pushes ·{" "}
              {g.totalLockedFormatted} locked ·{" "}
              {g.progress.milestonesCompleted}/{g.progress.totalMilestones} releases paid
            </p>
            <p className="muted small">{g.progress.summary}</p>
          </article>
        ))}
      </div>

      <section className="reviews">
        <h2>Community reviews</h2>
        <p className="muted">
          Reviews boost a developer&apos;s community score and help holders see who ships and cares about their product.
        </p>
        <form onSubmit={(e) => void submitReview(e)} className="review-form">
          <label>
            Rating
            <select value={rating} onChange={(e) => setRating(Number(e.target.value))}>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>{n} ★</option>
              ))}
            </select>
          </label>
          <label>
            Comment
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Ship quality, communication, vesting transparency…"
              rows={3}
            />
          </label>
          <button type="submit" disabled={submitting}>
            {wallet ? (submitting ? "Posting…" : "Post review") : "Connect wallet to review"}
          </button>
        </form>
        <ul className="review-list">
          {reviews.map((r) => (
            <li key={`${r.wallet}-${r.createdAt}`}>
              <strong>{"★".repeat(r.rating)}</strong>
              <span className="muted"> {shortAddr(r.wallet)} · {new Date(r.createdAt).toLocaleDateString()}</span>
              <p>{r.comment}</p>
            </li>
          ))}
        </ul>
      </section>

      <style>{`
        .page { max-width: 760px; margin: 0 auto; padding: 0 1rem 2rem; font-family: system-ui, sans-serif; }
        .dev-header { display: flex; gap: 1rem; align-items: flex-start; margin-bottom: 0.5rem; }
        .avatar { border-radius: 9999px; border: 2px solid #e5e7eb; }
        .header-sub { margin: 0.25rem 0 0.5rem; }
        .muted { color: #6b7280; font-size: 0.9rem; }
        .small { font-size: 0.85rem; }
        .link { display: inline-block; margin-right: 1rem; color: #7c3aed; font-size: 0.9rem; }
        .timeline { margin: 0 0 2rem; }
        .timeline h2 { font-size: 1.05rem; margin-bottom: 1rem; }
        .timeline ul { list-style: none; padding: 0; margin: 0; border-left: 2px solid #e5e7eb; margin-left: 0.5rem; }
        .timeline li { display: flex; gap: 1rem; padding: 0 0 1.25rem 1.25rem; position: relative; }
        .timeline-dot {
          position: absolute; left: -0.45rem; top: 0.2rem;
          width: 0.75rem; height: 0.75rem; border-radius: 50%; background: #d1d5db;
        }
        .timeline-dot.active { background: #7c3aed; }
        .timeline-dot.community { background: #f59e0b; }
        .timeline-dot.complete { background: #10b981; }
        .timeline li strong { display: block; font-size: 0.95rem; }
        .timeline li p { margin: 0.15rem 0 0; }
        .list { display: flex; flex-direction: column; gap: 1rem; margin-bottom: 2rem; }
        .card { border: 1px solid #e5e7eb; border-radius: 0.75rem; padding: 1rem 1.25rem; }
        .card h3 { margin: 0 0 0.35rem; }
        .card a { color: #7c3aed; text-decoration: none; }
        .reviews { border-top: 1px solid #e5e7eb; padding-top: 1.5rem; }
        .review-form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 28rem; margin: 1rem 0; }
        .review-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
        .review-form select, .review-form textarea {
          padding: 0.5rem; border-radius: 0.5rem; border: 1px solid #d1d5db;
        }
        .review-form button {
          align-self: flex-start; padding: 0.5rem 1rem; border-radius: 0.5rem;
          background: #7c3aed; color: #fff; border: none; cursor: pointer;
        }
        .review-list { list-style: none; padding: 0; }
        .review-list li { border-bottom: 1px solid #f3f4f6; padding: 0.75rem 0; }
        .review-list p { margin: 0.35rem 0 0; }
      `}</style>
    </div>
  );
}
