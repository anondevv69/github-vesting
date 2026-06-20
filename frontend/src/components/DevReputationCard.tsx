/**
 * Developer reputation card — level, score, badges earned over time.
 */

import type { DevBadge, DevReputation } from "../types/reputation";

type Props = {
  githubLogin: string;
  reputation: DevReputation;
  compact?: boolean;
};

export function DevReputationCard({ githubLogin, reputation, compact = false }: Props) {
  const { level, title, score, nextLevelScore, stats, scoreBreakdown, badges } = reputation;
  const progressToNext = nextLevelScore > score
    ? Math.min(100, Math.round((score / nextLevelScore) * 100))
    : 100;

  return (
    <section className={`dev-rep ${compact ? "dev-rep--compact" : ""}`}>
      <div className="dev-rep__hero">
        <div className="dev-rep__level-ring" aria-label={`Level ${level}`}>
          <span className="dev-rep__level-num">{level}</span>
        </div>
        <div>
          <p className="dev-rep__eyebrow">Developer reputation</p>
          <h2 className="dev-rep__title">{title}</h2>
          <p className="dev-rep__score-line">
            <strong>{score}</strong> / 100 reputation
            {score < nextLevelScore && (
              <span className="muted"> · {nextLevelScore - score} pts to next level</span>
            )}
          </p>
        </div>
      </div>

      <div className="dev-rep__bar-outer">
        <div className="dev-rep__bar-inner" style={{ width: `${progressToNext}%` }} />
      </div>

      {!compact && (
        <div className="dev-rep__stats">
          <div className="dev-rep__stat">
            <span className="dev-rep__stat-val">{stats.totalVerifiedPushes}</span>
            <span className="dev-rep__stat-label">verified pushes</span>
          </div>
          <div className="dev-rep__stat">
            <span className="dev-rep__stat-val">{stats.totalTokensLockedFormatted}</span>
            <span className="dev-rep__stat-label">tokens committed</span>
          </div>
          <div className="dev-rep__stat">
            <span className="dev-rep__stat-val">
              {stats.avgRating !== null ? `${stats.avgRating.toFixed(1)} ★` : "—"}
            </span>
            <span className="dev-rep__stat-label">{stats.reviewCount} reviews</span>
          </div>
          <div className="dev-rep__stat">
            <span className="dev-rep__stat-val">{stats.completedLocks}/{stats.totalRepos}</span>
            <span className="dev-rep__stat-label">vesting complete</span>
          </div>
        </div>
      )}

      <div className="dev-rep__breakdown">
        <span>Shipping {scoreBreakdown.shipping}/40</span>
        <span>Commitment {scoreBreakdown.commitment}/35</span>
        <span>Community {scoreBreakdown.community}/25</span>
      </div>

      <div className="dev-rep__badges">
        <h3>Earned badges</h3>
        {badges.length === 0 ? (
          <p className="muted">
            @{githubLogin} earns badges by locking tokens, shipping verified pushes, and collecting reviews.
          </p>
        ) : (
          <ul className="dev-rep__badge-grid">
            {badges.map((b) => (
              <BadgeChip key={b.id} badge={b} />
            ))}
          </ul>
        )}
      </div>

      {!compact && (
        <details className="dev-rep__next">
          <summary>How to earn more</summary>
          <ul>
            {BADGE_HINTS.filter((h) => !reputation.earnedBadgeIds.includes(h.id)).map((h) => (
              <li key={h.id}>
                <span>{h.icon}</span> <strong>{h.label}</strong> — {h.hint}
              </li>
            ))}
          </ul>
        </details>
      )}

      <style>{styles}</style>
    </section>
  );
}

function BadgeChip({ badge: b }: { badge: DevBadge }) {
  return (
    <li className="badge-chip" title={b.description}>
      <span className="badge-chip__icon">{b.icon}</span>
      <span className="badge-chip__label">{b.label}</span>
    </li>
  );
}

const BADGE_HINTS = [
  { id: "verified-shipper", icon: "🚀", label: "Verified Shipper", hint: "Ship 10 verified pushes to main" },
  { id: "prolific-shipper", icon: "⚡", label: "Prolific Shipper", hint: "50+ verified pushes total" },
  { id: "whale-commit", icon: "🐋", label: "Whale Commit", hint: "Lock 10M+ tokens in vesting" },
  { id: "vesting-complete", icon: "✅", label: "Vesting Complete", hint: "Finish a full vesting schedule" },
  { id: "multi-repo", icon: "📦", label: "Multi-Repo", hint: "Lock tokens on 2+ repos" },
  { id: "community-trusted", icon: "⭐", label: "Community Trusted", hint: "4.5+ stars from 3+ reviews" },
  { id: "milestone-maker", icon: "🏆", label: "Milestone Maker", hint: "3+ on-chain token releases paid" },
];

const styles = `
  .dev-rep {
    background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4c1d95 100%);
    color: #f5f3ff;
    border-radius: 1rem;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }
  .dev-rep--compact { padding: 1rem; }
  .dev-rep__hero { display: flex; gap: 1rem; align-items: center; margin-bottom: 1rem; }
  .dev-rep__level-ring {
    width: 3.5rem; height: 3.5rem; border-radius: 50%;
    background: linear-gradient(135deg, #a78bfa, #7c3aed);
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 0 0 3px rgba(255,255,255,0.15);
    flex-shrink: 0;
  }
  .dev-rep__level-num { font-size: 1.4rem; font-weight: 800; }
  .dev-rep__eyebrow {
    margin: 0; font-size: 0.7rem; text-transform: uppercase;
    letter-spacing: 0.1em; opacity: 0.75;
  }
  .dev-rep__title { margin: 0.15rem 0; font-size: 1.35rem; }
  .dev-rep__score-line { margin: 0; font-size: 0.95rem; }
  .dev-rep__score-line .muted { opacity: 0.8; font-weight: 400; }
  .dev-rep__bar-outer {
    background: rgba(255,255,255,0.15); border-radius: 9999px;
    height: 0.5rem; margin-bottom: 1.25rem; overflow: hidden;
  }
  .dev-rep__bar-inner {
    background: linear-gradient(90deg, #c4b5fd, #f0abfc);
    height: 100%; border-radius: 9999px;
  }
  .dev-rep__stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
    gap: 0.75rem; margin-bottom: 1rem;
  }
  .dev-rep__stat {
    background: rgba(255,255,255,0.08); border-radius: 0.5rem; padding: 0.65rem 0.75rem;
  }
  .dev-rep__stat-val { display: block; font-weight: 700; font-size: 1.05rem; }
  .dev-rep__stat-label { font-size: 0.72rem; opacity: 0.75; text-transform: uppercase; }
  .dev-rep__breakdown {
    display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.8rem; opacity: 0.85;
    margin-bottom: 1.25rem;
  }
  .dev-rep__badges h3 { margin: 0 0 0.75rem; font-size: 0.95rem; }
  .dev-rep__badge-grid {
    list-style: none; padding: 0; margin: 0;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: 0.5rem;
  }
  .badge-chip {
    background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.2);
    border-radius: 0.65rem; padding: 0.55rem 0.65rem;
    display: flex; flex-direction: column; gap: 0.15rem;
  }
  .badge-chip__icon { font-size: 1.25rem; }
  .badge-chip__label { font-size: 0.75rem; font-weight: 600; }
  .dev-rep__next { margin-top: 1rem; font-size: 0.85rem; opacity: 0.9; }
  .dev-rep__next summary { cursor: pointer; font-weight: 600; }
  .dev-rep__next ul { margin: 0.5rem 0 0; padding-left: 0; list-style: none; }
  .dev-rep__next li { margin-bottom: 0.35rem; }
  .muted { opacity: 0.85; font-size: 0.9rem; }
`;
