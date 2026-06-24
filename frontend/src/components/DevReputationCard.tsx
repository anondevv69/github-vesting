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
    <section className={`dev-rep${compact ? " dev-rep--compact" : ""}`}>
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
