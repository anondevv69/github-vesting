import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { VestingFooter } from "../components/VestingFooter";
import { CopyButton } from "../components/CopyButton";
import { formatTokens, shortAddr } from "../lib/format";

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
    reason?: string;
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
  bankr?: {
    name: string;
    symbol: string;
    imageUri?: string;
    feeRecipient: {
      wallet: string;
      xUsername?: string;
      xProfileImageUrl?: string;
    };
    launchUrl: string;
  } | null;
};

function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function ipfsToHttp(uri?: string): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  return uri;
}

type PushEntry = LockResponse["recentPushes"][number];

function pushStatus(p: PushEntry): "counted" | "rejected" {
  return p.accepted !== false ? "counted" : "rejected";
}

function rejectionCategory(reason?: string): string {
  const r = (reason ?? "").toLowerCase();
  if (r.includes("min since last") || r.includes("cooldown")) return "Cooldown";
  if (r.includes("daily cap")) return "Daily cap";
  if (r.includes("already counted") || r.includes("duplicate")) return "Duplicate";
  if (r.includes("docs") || r.includes("lockfile")) return "Not code";
  if (r.includes("force-push")) return "Force-push";
  if (r.includes("production branch")) return "Wrong branch";
  if (r.includes("substantial")) return "Too small";
  return "Rule";
}

function summarizePushes(pushes: PushEntry[]) {
  const counted = pushes.filter((p) => pushStatus(p) === "counted");
  const rejected = pushes.filter((p) => pushStatus(p) === "rejected");
  const byCategory = new Map<string, number>();
  for (const p of rejected) {
    const cat = rejectionCategory(p.reason);
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
  }
  return { total: pushes.length, counted: counted.length, rejected: rejected.length, byCategory };
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
  const timeline = [...recentPushes].reverse();
  const pushSummary = summarizePushes(recentPushes);
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
        <div className="token-section__head">
          {data.bankr?.imageUri && (
            <img src={ipfsToHttp(data.bankr.imageUri)} alt="" className="token-section__logo" width={40} height={40} />
          )}
          <div>
            <p className="token-section__symbol">
              {data.bankr?.symbol || grant.token.slice(0, 6)}
              {data.bankr?.name ? ` · ${data.bankr.name}` : ""}
            </p>
            <div className="token-section__addr">
              <code>{grant.token}</code>
              <CopyButton text={grant.token} />
              <a href={`${explorerBase}/address/${grant.token}`} target="_blank" rel="noreferrer">
                Basescan
              </a>
              {data.bankr?.launchUrl && (
                <a href={data.bankr.launchUrl} target="_blank" rel="noreferrer">
                  Bankr
                </a>
              )}
            </div>
          </div>
        </div>

        {data.bankr?.feeRecipient && (
          <div className="fee-recipient-card">
            <span className="fee-recipient-card__label">Fee recipient</span>
            <div className="fee-recipient-card__person">
              {data.bankr.feeRecipient.xProfileImageUrl ? (
                <img
                  src={data.bankr.feeRecipient.xProfileImageUrl}
                  alt=""
                  width={36}
                  height={36}
                  className="fee-recipient-card__avatar"
                />
              ) : (
                <span className="fee-recipient-card__avatar fee-recipient-card__avatar--placeholder" />
              )}
              <div>
                {data.bankr.feeRecipient.xUsername ? (
                  <a
                    href={`https://x.com/${data.bankr.feeRecipient.xUsername}`}
                    target="_blank"
                    rel="noreferrer"
                    className="fee-recipient-card__handle"
                  >
                    @{data.bankr.feeRecipient.xUsername}
                  </a>
                ) : (
                  <code className="fee-recipient-card__handle">{shortAddr(data.bankr.feeRecipient.wallet)}</code>
                )}
                <span className="fee-recipient-card__wallet muted">
                  {shortAddr(data.bankr.feeRecipient.wallet)}
                  <CopyButton text={data.bankr.feeRecipient.wallet} />
                </span>
              </div>
            </div>
          </div>
        )}
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
        <h2>Push activity</h2>
        <p className="muted search-hints">
          Every push to this repo is recorded here. Only verified pushes advance your milestone —
          others are visible so you can see work happening and why something did not count.
        </p>

        {pushSummary.total > 0 && (
          <div className="push-activity-summary">
            <div className="push-activity-summary__stat">
              <span className="push-activity-summary__value">{pushSummary.total}</span>
              <span className="push-activity-summary__label">pushes received</span>
            </div>
            <div className="push-activity-summary__stat push-activity-summary__stat--green">
              <span className="push-activity-summary__value">{progress.verifiedPushCount}</span>
              <span className="push-activity-summary__label">counted toward lock</span>
            </div>
            {pushSummary.rejected > 0 && (
              <div className="push-activity-summary__stat push-activity-summary__stat--amber">
                <span className="push-activity-summary__value">{pushSummary.rejected}</span>
                <span className="push-activity-summary__label">not counted (see below)</span>
              </div>
            )}
          </div>
        )}

        {pushSummary.rejected > 0 && (
          <div className="push-activity-callout">
            <strong>Recent pushes not counted:</strong>{" "}
            {[...pushSummary.byCategory.entries()].map(([cat, n]) => `${n}× ${cat}`).join(" · ")}
            . Cooldown is 30 minutes between counted pushes; substantial code changes (~50+ lines)
            can bypass it. <Link to="/help">Full rules →</Link>
          </div>
        )}

        {timeline.length === 0 ? (
          <p className="muted">No pushes recorded yet.</p>
        ) : (
          <ul className="timeline-feed">
            {timeline.map((p) => {
              const verified = pushStatus(p) === "counted";
              const rejectCat = verified ? null : rejectionCategory(p.reason);
              return (
                <li
                  key={`${p.sha}-${p.ts}`}
                  className={`timeline-feed__item${verified ? "" : " timeline-feed__item--rejected"}`}
                >
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
                  <span className="timeline-feed__detail">
                    {verified ? (
                      <>
                        {p.commitCount ?? 1} file{(p.commitCount ?? 1) === 1 ? "" : "s"}
                        {" · ~"}
                        {p.linesEstimate ?? "—"} lines
                        {p.reason?.includes("cooldown bypassed") && (
                          <span className="timeline-feed__note"> · substantial fix</span>
                        )}
                      </>
                    ) : (
                      <>
                        {(p.linesEstimate != null || p.commitCount) && (
                          <span className="timeline-feed__changes">
                            {p.commitCount ?? 1} file{(p.commitCount ?? 1) === 1 ? "" : "s"}
                            {p.linesEstimate != null && (
                              <> · ~{p.linesEstimate} lines changed</>
                            )}
                            {" · "}
                          </span>
                        )}
                        <span className="timeline-feed__reason">{p.reason ?? "Not counted"}</span>
                        {rejectCat && (
                          <span className="timeline-feed__category">{rejectCat}</span>
                        )}
                      </>
                    )}
                  </span>
                  <span className={verified ? "badge-verified" : "badge-rejected"}>
                    {verified ? "counted" : "not counted"}
                  </span>
                </li>
              );
            })}
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

      <VestingFooter />
    </div>
  );
}
