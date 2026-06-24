import { useEffect, useState, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import type { Address } from "viem";
import { VestingNav } from "../components/VestingNav";
import { StarRating } from "../components/StarRating";
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

type ActivityEntry = {
  repoFullName: string;
  ts: number;
  sha: string;
  reason: string;
  linesEstimate?: number;
};

type Tab = "locks" | "activity" | "feedback";

export function VestingDevPage() {
  const { login = "" } = useParams();
  const [grants, setGrants] = useState<GrantSummary[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reputation, setReputation] = useState<DevReputation | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("locks");
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [wallet, setWallet] = useState<Address | null>(null);
  const [showReviewForm, setShowReviewForm] = useState(false);
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
      }>)
      .then((d) => {
        setGrants(d.grants ?? []);
        setReviews(d.reviews ?? []);
        setReputation(d.reputation ?? null);
      })
      .finally(() => setLoading(false));
  }, [login]);

  useEffect(() => {
    loadDev();
  }, [loadDev]);

  useEffect(() => {
    if (tab !== "activity" || grants.length === 0) return;
    setActivityLoading(true);
    Promise.all(
      grants.map((g) =>
        fetch(`${API_BASE}/api/vesting/status?repo=${encodeURIComponent(g.repoFullName)}`)
          .then((r) => r.json() as Promise<{
            ok: boolean;
            grant?: { repoFullName: string };
            recentPushes?: Array<{
              ts: number;
              sha: string;
              reason: string;
              linesEstimate?: number;
              accepted?: boolean;
            }>;
          }>),
      ),
    )
      .then((results) => {
        const rows: ActivityEntry[] = [];
        for (const r of results) {
          if (!r.ok || !r.grant) continue;
          for (const p of r.recentPushes ?? []) {
            if (p.accepted === false) continue;
            rows.push({
              repoFullName: r.grant.repoFullName,
              ts: p.ts,
              sha: p.sha,
              reason: p.reason,
              linesEstimate: p.linesEstimate,
            });
          }
        }
        rows.sort((a, b) => b.ts - a.ts);
        setActivity(rows);
      })
      .finally(() => setActivityLoading(false));
  }, [tab, grants]);

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
      setShowReviewForm(false);
      loadDev();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to post review");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="vesting-page vesting-page--wide">
      <VestingNav />

      {loading && <p className="muted">Loading developer profile…</p>}

      {!loading && (
        <div className="dev-layout">
          <aside className="dev-sidebar">
            <img
              src={`https://github.com/${login}.png?size=480`}
              alt=""
              className="dev-sidebar__avatar"
              width={240}
              height={240}
            />
            <p className="dev-sidebar__handle">@{login}</p>
            {reputation && (
              <>
                <div className="dev-sidebar__stat">
                  <span className="dev-sidebar__stat-label">Joined</span>
                  <span>
                    {reputation.stats.firstLockAt
                      ? new Date(reputation.stats.firstLockAt).toLocaleDateString()
                      : "—"}
                  </span>
                </div>
                <div className="dev-sidebar__stat">
                  <span className="dev-sidebar__stat-label">Tokens locked</span>
                  <span>{reputation.stats.totalTokensLockedFormatted}</span>
                </div>
                <div className="dev-sidebar__stat">
                  <span className="dev-sidebar__stat-label">Verified pushes</span>
                  <span>{reputation.stats.totalVerifiedPushes}</span>
                </div>
                <div className="dev-sidebar__stat">
                  <span className="dev-sidebar__stat-label">Reputation</span>
                  <span>Lv.{reputation.level} · {reputation.score}</span>
                </div>
              </>
            )}
            <p className="muted" style={{ marginTop: "1rem", fontSize: "0.8125rem" }}>
              {reputation?.title ?? "Developer"}
            </p>
            <a href={`https://github.com/${login}`} target="_blank" rel="noreferrer">
              GitHub profile →
            </a>
          </aside>

          <main>
            <div className="tabs">
              {(["locks", "activity", "feedback"] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`tabs__btn${tab === t ? " active" : ""}`}
                  onClick={() => setTab(t)}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {tab === "locks" && (
              <>
                {grants.length === 0 && (
                  <p className="muted">No public vesting locks for this developer yet.</p>
                )}
                <div className="lock-grid">
                  {grants.map((g) => {
                    const pct = g.progress.totalPushesRequired > 0
                      ? Math.floor((g.progress.verifiedPushCount / g.progress.totalPushesRequired) * 100)
                      : 0;
                    return (
                      <article key={g.repoFullName} className="lock-grid__card">
                        <p className="lock-grid__repo">
                          <Link to={`/vesting/status?repo=${encodeURIComponent(g.repoFullName)}`}>
                            {g.repoFullName}
                          </Link>
                        </p>
                        <p className="muted" style={{ fontSize: "0.75rem", margin: "0 0 0.5rem" }}>
                          {g.totalLockedFormatted} locked
                        </p>
                        <div className="bar-outer">
                          <div className="bar-inner" style={{ width: `${pct}%` }} />
                        </div>
                        <p className="progress-label">
                          {g.progress.verifiedPushCount}/{g.progress.totalPushesRequired} pushes
                        </p>
                        <span className={`badge ${g.status}`}>{g.status}</span>
                      </article>
                    );
                  })}
                </div>
              </>
            )}

            {tab === "activity" && (
              <>
                {activityLoading && <p className="muted">Loading activity…</p>}
                {!activityLoading && activity.length === 0 && (
                  <p className="muted">No verified push activity yet.</p>
                )}
                <ul className="activity-feed">
                  {activity.map((a) => (
                    <li key={`${a.repoFullName}-${a.sha}`} className="activity-feed__item">
                      <div className="activity-feed__repo">{a.repoFullName}</div>
                      <div>
                        {a.reason.slice(0, 72)}
                        {a.reason.length > 72 ? "…" : ""}
                      </div>
                      <div className="activity-feed__meta">
                        {new Date(a.ts).toLocaleString()}
                        {" · "}
                        <a
                          href={`https://github.com/${a.repoFullName}/commit/${a.sha}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {a.sha.slice(0, 7)}
                        </a>
                        {a.linesEstimate != null && ` · ~${a.linesEstimate} lines`}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {tab === "feedback" && (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ maxWidth: "12rem", marginBottom: "1rem" }}
                  onClick={() => {
                    if (!wallet) void connectWallet();
                    setShowReviewForm((v) => !v);
                  }}
                >
                  Leave feedback
                </button>

                {showReviewForm && (
                  <form onSubmit={(e) => void submitReview(e)} className="review-form">
                    <label>
                      Rating
                      <select value={rating} onChange={(e) => setRating(Number(e.target.value))}>
                        {[5, 4, 3, 2, 1].map((n) => (
                          <option key={n} value={n}>{n} stars</option>
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
                        required
                        minLength={3}
                      />
                    </label>
                    <button type="submit" className="btn btn-primary" disabled={submitting}>
                      {submitting ? "Posting…" : wallet ? "Post review" : "Connect wallet & post"}
                    </button>
                  </form>
                )}

                <ul className="review-list">
                  {reviews.map((r) => (
                    <li key={`${r.wallet}-${r.createdAt}`} className="review-list__item">
                      <div className="review-list__header">
                        <StarRating rating={r.rating} />
                        <span className="muted">{shortAddr(r.wallet)}</span>
                        <span className="muted">{new Date(r.createdAt).toLocaleDateString()}</span>
                      </div>
                      <p style={{ margin: 0 }}>{r.comment}</p>
                    </li>
                  ))}
                  {reviews.length === 0 && (
                    <li className="muted">No reviews yet.</li>
                  )}
                </ul>
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
