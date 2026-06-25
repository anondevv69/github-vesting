import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { VestingFooter } from "../components/VestingFooter";
import { StarRating } from "../components/StarRating";
import { CopyButton } from "../components/CopyButton";
import { shortAddr } from "../lib/format";
import { useVestingAuth } from "../hooks/useVestingAuth";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const API_FETCH: RequestInit = { credentials: "include" };

type GrantSummary = {
  repoFullName: string;
  token: string;
  status: string;
  totalLockedFormatted: string;
  recipient: string;
  progress: {
    verifiedPushCount: number;
    totalPushesRequired: number;
  };
};

type Review = {
  wallet: string;
  rating: number;
  comment: string;
  createdAt: string;
};

type DevProfile = {
  githubLogin: string;
  displayName?: string;
  bio?: string;
  twitter?: string;
  website?: string;
  links?: Array<{ label: string; url: string }>;
};

type ReputationStats = {
  totalVerifiedPushes: number;
  totalTokensLockedFormatted: string;
  activeLocks: number;
  firstLockAt: string | null;
};

type LinkedWallet = {
  wallet: string;
  linkedAt: string;
  source: "signed" | "repo-claim" | "lock" | "bankr";
};

type FeeRecipientToken = {
  symbol: string;
  name: string;
  address: string;
  bankrHandle?: string;
};

type FeeRecipientEntry = {
  wallet: string;
  source: LinkedWallet["source"];
  linkedAt: string;
  tokens: FeeRecipientToken[];
};

import { lockPathFromRepo } from "../lib/repoId";

function lockPath(repoFullName: string): string {
  return lockPathFromRepo(repoFullName);
}

export function DevProfilePage() {
  const { username = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [grants, setGrants] = useState<GrantSummary[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [stats, setStats] = useState<ReputationStats | null>(null);
  const [profile, setProfile] = useState<DevProfile | null>(null);
  const [editable, setEditable] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { wallet, githubUser, connectWallet, connectGitHub } = useVestingAuth();
  const [showAllReviews, setShowAllReviews] = useState(false);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState<DevProfile>({ githubLogin: username });
  const [saving, setSaving] = useState(false);
  const [linkedWallets, setLinkedWallets] = useState<LinkedWallet[]>([]);
  const [feeRecipientEntries, setFeeRecipientEntries] = useState<FeeRecipientEntry[]>([]);
  const [canLinkWallet, setCanLinkWallet] = useState(false);
  const [walletLinked, setWalletLinked] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const [linkSuccess, setLinkSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (searchParams.get("wallet_linked") === "1") {
      setLinkSuccess("Bankr wallet linked to this GitHub profile.");
      const next = new URLSearchParams(searchParams);
      next.delete("wallet_linked");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const load = useCallback(() => {
    if (!username) return;
    setLoading(true);
    setLoadError(null);
    const walletQ = wallet ? `wallet=${wallet}` : "";
    Promise.all([
      fetch(`${API_BASE}/api/vesting/by-dev/${username}`),
      fetch(`${API_BASE}/api/vesting/dev-profile/${username}?${walletQ}`, API_FETCH),
    ])
      .then(async ([devRes, profRes]) => {
        if (!devRes.ok) {
          const errBody = await devRes.json().catch(() => ({})) as { error?: string; message?: string };
          throw new Error(errBody.error ?? errBody.message ?? `API error ${devRes.status}`);
        }
        const dev = await devRes.json() as {
          ok?: boolean;
          grants?: GrantSummary[];
          reviews?: Review[];
          reputation?: { stats: ReputationStats };
          error?: string;
        };
        if (dev.ok === false) throw new Error(dev.error ?? "Failed to load locks");
        const prof = profRes.ok
          ? await profRes.json() as {
              profile?: DevProfile;
              editable?: boolean;
              linkedWallets?: LinkedWallet[];
              canLinkWallet?: boolean;
              walletLinked?: boolean;
            }
          : { profile: { githubLogin: username }, editable: false };
        setGrants(dev.grants ?? []);
        setReviews(dev.reviews ?? []);
        setStats(dev.reputation?.stats ?? null);
        setProfile(prof.profile ?? { githubLogin: username });
        setDraft(prof.profile ?? { githubLogin: username, links: [] });
        setEditable(!!prof.editable);
        setLinkedWallets(prof.linkedWallets ?? []);
        setCanLinkWallet(!!prof.canLinkWallet);
        setWalletLinked(!!prof.walletLinked);

        const wallets = prof.linkedWallets ?? [];
        if (wallets.length > 0) {
          fetch(`${API_BASE}/api/dev/link-wallet/${username}`, API_FETCH)
            .then((r) => r.json())
            .then((d: { ok?: boolean; feeRecipientTokens?: FeeRecipientEntry[] }) => {
              if (d.ok && d.feeRecipientTokens) setFeeRecipientEntries(d.feeRecipientTokens);
            })
            .catch(() => setFeeRecipientEntries([]));
        } else {
          setFeeRecipientEntries([]);
        }
      })
      .catch((e) => {
        setGrants([]);
        setReviews([]);
        setStats(null);
        setLoadError(e instanceof Error ? e.message : "Could not load profile");
      })
      .finally(() => setLoading(false));
  }, [username, wallet]);

  useEffect(() => {
    load();
  }, [load]);

  async function linkWalletToProfile() {
    if (!wallet) {
      await connectWallet();
      return;
    }
    if (!githubUser || githubUser.login.toLowerCase() !== username.toLowerCase()) {
      connectGitHub();
      return;
    }

    setLinkBusy(true);
    setLinkMessage(null);
    try {
      const eth = (window as Window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<string> } }).ethereum;
      if (!eth) throw new Error("Wallet required to sign link message");

      const challengeRes = await fetch(`${API_BASE}/api/dev/link-wallet/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wallet-address": wallet },
        ...API_FETCH,
      });
      const challenge = await challengeRes.json() as {
        ok?: boolean;
        error?: string;
        signMessage?: string;
      };
      if (!challenge.ok || !challenge.signMessage) {
        throw new Error(challenge.error ?? "Failed to start wallet link");
      }

      const signature = await eth.request({
        method: "personal_sign",
        params: [challenge.signMessage, wallet],
      });

      const confirmRes = await fetch(`${API_BASE}/api/dev/link-wallet/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wallet-address": wallet },
        body: JSON.stringify({
          wallet,
          signature,
          signMessage: challenge.signMessage,
        }),
        ...API_FETCH,
      });
      const confirmed = await confirmRes.json() as { ok?: boolean; error?: string };
      if (!confirmed.ok) throw new Error(confirmed.error ?? "Wallet link failed");

      setLinkMessage("Wallet linked to your GitHub profile.");
      load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Wallet link failed";
      setLinkMessage(
        msg.includes("Invalid wallet signature")
          ? `${msg} — Bankr smart wallets: use "link github rayblancoeth" in Bankr terminal for magic link, or retry after API deploy.`
          : msg,
      );
    } finally {
      setLinkBusy(false);
    }
  }

  async function saveProfile() {
    if (!wallet) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/vesting/dev-profile/${username}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-wallet-address": wallet },
        body: JSON.stringify({ ...draft, wallet, links: (draft.links ?? []).slice(0, 4) }),
      });
      const d = await res.json() as { ok: boolean; profile?: DevProfile; error?: string };
      if (!d.ok) throw new Error(d.error ?? "Save failed");
      setProfile(d.profile ?? draft);
      setEditMode(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function submitReview(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet) {
      await connectWallet();
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/vesting/by-dev/${username}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wallet-address": wallet },
        body: JSON.stringify({ wallet, rating, comment }),
      });
      const d = await res.json() as { ok: boolean; error?: string };
      if (!d.ok) throw new Error(d.error ?? "Failed");
      setComment("");
      setShowReviewForm(false);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  const displayWallet = grants[0]?.recipient;
  const visibleReviews = showAllReviews ? reviews : reviews.slice(0, 5);
  const canLeaveFeedback = wallet && !editable;

  return (
    <div className="vesting-page vesting-page--wide">
      <VestingNav />

      {loading && <p className="muted">Loading profile…</p>}

      {!loading && loadError && (
        <div className="vesting-card" style={{ marginBottom: "1.5rem" }}>
          <p className="err">Could not load locks — {loadError}</p>
          <p className="muted">
            The API may be temporarily down. Your lock pages (e.g.{" "}
            <Link to={`/lock/${username}/github-vesting`}>/lock/{username}/github-vesting</Link>
            ) work independently once the backend is back.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => load()}>
            Retry
          </button>
        </div>
      )}

      {!loading && (
        <div className="dev-layout dev-layout--profile">
          <aside className="dev-sidebar dev-sidebar--narrow">
            <img
              src={`https://github.com/${username}.png?size=440`}
              alt=""
              className="dev-sidebar__avatar dev-sidebar__avatar--md"
              width={220}
              height={220}
            />

            {editMode ? (
              <>
                <input
                  className="profile-input"
                  placeholder="Display name"
                  value={draft.displayName ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, displayName: e.target.value }))}
                />
                <p className="dev-sidebar__handle">@{username}</p>
                <textarea
                  className="profile-input"
                  placeholder="Bio"
                  rows={2}
                  value={draft.bio ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, bio: e.target.value }))}
                />
                <label className="profile-field">
                  <span className="profile-field__icon">𝕏</span>
                  <input
                    className="profile-input"
                    placeholder="handle"
                    value={draft.twitter ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, twitter: e.target.value }))}
                  />
                </label>
                <input
                  className="profile-input"
                  placeholder="Website URL"
                  value={draft.website ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, website: e.target.value }))}
                />
                {(draft.links ?? []).map((link, i) => (
                  <div key={i} className="profile-link-row">
                    <input
                      className="profile-input"
                      placeholder="Label"
                      value={link.label}
                      onChange={(e) => {
                        const links = [...(draft.links ?? [])];
                        links[i] = { ...links[i]!, label: e.target.value };
                        setDraft((d) => ({ ...d, links }));
                      }}
                    />
                    <input
                      className="profile-input"
                      placeholder="URL"
                      value={link.url}
                      onChange={(e) => {
                        const links = [...(draft.links ?? [])];
                        links[i] = { ...links[i]!, url: e.target.value };
                        setDraft((d) => ({ ...d, links }));
                      }}
                    />
                  </div>
                ))}
                {(draft.links ?? []).length < 4 && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        links: [...(d.links ?? []), { label: "", url: "" }],
                      }))
                    }
                  >
                    + Add link
                  </button>
                )}
                <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void saveProfile()}>
                  {saving ? "Saving…" : "Save profile"}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setEditMode(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <h1 className="dev-sidebar__name">{profile?.displayName ?? username}</h1>
                <p className="dev-sidebar__handle">@{username}</p>
                {profile?.bio && <p className="dev-sidebar__bio">{profile.bio}</p>}
                {profile?.twitter && (
                  <a href={`https://x.com/${profile.twitter}`} target="_blank" rel="noreferrer">
                    @{profile.twitter}
                  </a>
                )}
                {profile?.website && (
                  <a href={profile.website} target="_blank" rel="noreferrer">{profile.website}</a>
                )}
                {(profile?.links ?? []).map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label || l.url}</a>
                ))}
              </>
            )}

            {stats && (
              <div className="dev-sidebar__stats">
                <div className="dev-sidebar__stat">
                  <span className="dev-sidebar__stat-label">Tokens locked</span>
                  <span>{stats.totalTokensLockedFormatted}</span>
                </div>
                <div className="dev-sidebar__stat">
                  <span className="dev-sidebar__stat-label">Verified pushes</span>
                  <span>{stats.totalVerifiedPushes}</span>
                </div>
                <div className="dev-sidebar__stat">
                  <span className="dev-sidebar__stat-label">Active locks</span>
                  <span>{stats.activeLocks}</span>
                </div>
              </div>
            )}

            {displayWallet && linkedWallets.length === 0 && (
              <p className="dev-sidebar__wallet">
                <code>{shortAddr(displayWallet)}</code>
                <CopyButton text={displayWallet} />
              </p>
            )}

            {linkedWallets.length > 0 && (
              <div className="dev-sidebar__stats" style={{ marginTop: "0.75rem" }}>
                <span className="dev-sidebar__stat-label">Linked wallets</span>
                {linkedWallets.map((w) => (
                  <p key={w.wallet} className="dev-sidebar__wallet" style={{ margin: "0.35rem 0" }}>
                    <code>{shortAddr(w.wallet)}</code>
                    <CopyButton text={w.wallet} />
                  </p>
                ))}
              </div>
            )}

            {feeRecipientEntries.some((e) => e.tokens.length > 0) && (
              <div className="dev-sidebar__stats" style={{ marginTop: "0.75rem" }}>
                <span className="dev-sidebar__stat-label">Bankr fee recipient</span>
                {feeRecipientEntries.flatMap((e) =>
                  e.tokens.map((t) => (
                    <p key={`${e.wallet}-${t.address}`} className="muted" style={{ margin: "0.25rem 0", fontSize: "0.85rem" }}>
                      {t.bankrHandle ? `@${t.bankrHandle}` : t.symbol}
                      {" · "}
                      <code>{shortAddr(e.wallet)}</code>
                    </p>
                  )),
                )}
              </div>
            )}

            {canLinkWallet && !walletLinked && (
              <div style={{ marginTop: "0.75rem" }}>
                {!githubUser || githubUser.login.toLowerCase() !== username.toLowerCase() ? (
                  <button type="button" className="btn btn-ghost" onClick={connectGitHub}>
                    Sign in with GitHub to link wallet
                  </button>
                ) : !wallet ? (
                  <button type="button" className="btn btn-ghost" onClick={() => void connectWallet()}>
                    Connect wallet to link
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={linkBusy}
                    onClick={() => void linkWalletToProfile()}
                  >
                    {linkBusy ? "Linking…" : `Link ${shortAddr(wallet)} to profile`}
                  </button>
                )}
                <p className="muted" style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}>
                  Link your Bankr fee-recipient wallet so it shows on your dev profile and lets you edit settings.
                </p>
                {linkMessage && <p className={linkMessage.includes("linked") ? "ok" : "err"}>{linkMessage}</p>}
              </div>
            )}

            {walletLinked && canLinkWallet && (
              <p className="muted" style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}>
                Connected wallet is linked to this profile.
              </p>
            )}

            {linkSuccess && (
              <p className="ok" style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>{linkSuccess}</p>
            )}

            {editable && !editMode && (
              <button type="button" className="btn" onClick={() => setEditMode(true)}>
                Edit profile
              </button>
            )}
          </aside>

          <main className="dev-main">
            <section>
              <h2>Active locks</h2>
              {grants.length === 0 ? (
                <p className="muted">No public locks yet.</p>
              ) : (
                <div className="lock-grid">
                  {grants.map((g) => {
                    const pct = g.progress.totalPushesRequired > 0
                      ? Math.floor((g.progress.verifiedPushCount / g.progress.totalPushesRequired) * 100)
                      : 0;
                    return (
                      <Link key={g.repoFullName} to={lockPath(g.repoFullName)} className="lock-grid__card lock-grid__card--link">
                        <p className="lock-grid__repo">{g.repoFullName}</p>
                        <p className="muted" style={{ fontSize: "0.75rem" }}>{g.totalLockedFormatted}</p>
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

            <section style={{ marginTop: "2rem" }}>
              <h2>Feedback</h2>
              {canLeaveFeedback && (
                <button
                  type="button"
                  className="btn"
                  style={{ marginBottom: "1rem" }}
                  onClick={() => setShowReviewForm((v) => !v)}
                >
                  Leave feedback
                </button>
              )}

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
                      rows={3}
                      required
                      minLength={3}
                    />
                  </label>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? "Posting…" : "Submit"}
                  </button>
                </form>
              )}

              <ul className="review-list">
                {visibleReviews.map((r) => (
                  <li key={`${r.wallet}-${r.createdAt}`} className="review-list__item">
                    <div className="review-list__header">
                      <span>{shortAddr(r.wallet)}</span>
                      <StarRating rating={r.rating} />
                      <span className="muted">{new Date(r.createdAt).toLocaleDateString()}</span>
                    </div>
                    <p style={{ margin: 0 }}>{r.comment}</p>
                  </li>
                ))}
                {reviews.length === 0 && <li className="muted">No reviews yet.</li>}
              </ul>
              {reviews.length > 5 && (
                <button type="button" className="btn btn-ghost" onClick={() => setShowAllReviews((v) => !v)}>
                  {showAllReviews ? "Show less" : "Show all"}
                </button>
              )}
            </section>
          </main>
        </div>
      )}

      <VestingFooter />
    </div>
  );
}
