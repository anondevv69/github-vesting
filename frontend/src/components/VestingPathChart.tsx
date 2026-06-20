/**
 * Glidepath-inspired chart: push milestones → token releases.
 */

type Props = {
  totalPushes: number;
  pushesPerMilestone: number;
  tokensPerMilestone: string;
  tokenSymbol: string;
  verifiedPushCount?: number;
  milestonesPaid?: number;
};

export function VestingPathChart({
  totalPushes,
  pushesPerMilestone,
  tokensPerMilestone,
  tokenSymbol,
  verifiedPushCount = 0,
  milestonesPaid = 0,
}: Props) {
  const milestoneCount = pushesPerMilestone > 0
    ? Math.floor(totalPushes / pushesPerMilestone)
    : 0;
  const perMilestone = Number(tokensPerMilestone) / 1e18;
  const perFormatted = perMilestone >= 1_000_000
    ? `${(perMilestone / 1_000_000).toFixed(2)}M`
    : perMilestone >= 1_000
      ? `${(perMilestone / 1_000).toFixed(2)}k`
      : perMilestone.toLocaleString(undefined, { maximumFractionDigits: 2 });

  const steps = [
    { label: "Lock", pushAt: 0, release: 0, paid: true },
    ...Array.from({ length: milestoneCount }, (_, i) => ({
      label: `Release ${i + 1}`,
      pushAt: (i + 1) * pushesPerMilestone,
      release: perMilestone,
      paid: i < milestonesPaid,
    })),
  ];

  const maxPush = totalPushes || 1;

  return (
    <div className="vesting-path">
      <div className="vesting-path__header">
        <div>
          <span className="vesting-path__eyebrow">GitHub-gated vesting</span>
          <h3>Your unlock path</h3>
        </div>
        <p className="vesting-path__summary">
          {milestoneCount === 1
            ? `${totalPushes} verified push${totalPushes === 1 ? "" : "es"} on main → one payout of ${perFormatted} ${tokenSymbol}`
            : `${pushesPerMilestone} pushes per release · ${milestoneCount} releases · ${perFormatted} ${tokenSymbol} each`}
        </p>
      </div>

      <div className="vesting-path__chart">
        {steps.map((step, i) => {
          const widthPct = step.pushAt === 0 ? 8 : Math.max(12, (step.pushAt / maxPush) * 100);
          const reached = verifiedPushCount >= step.pushAt;
          return (
            <div key={i} className="vesting-path__row">
              <div className="vesting-path__label">
                {step.label}
                {step.pushAt > 0 && (
                  <span className="muted"> @ {step.pushAt} push{step.pushAt === 1 ? "" : "es"}</span>
                )}
              </div>
              <div className="vesting-path__bar-wrap">
                <div
                  className={`vesting-path__bar ${step.paid ? "paid" : reached ? "reached" : ""}`}
                  style={{ width: `${widthPct}%` }}
                />
              </div>
              <div className="vesting-path__value">
                {step.release > 0 ? `${perFormatted} ${tokenSymbol}` : "Start"}
              </div>
            </div>
          );
        })}
      </div>

      <ol className="vesting-path__how">
        <li>
          <strong>One GitHub push = one count.</strong> A single commit to <code>main</code> counts once.
          Amending or re-pushing the same commit does not double-count.
        </li>
        <li>
          <strong>Meaningful code only.</strong> ≥50 lines of real code (not docs/lockfiles), on{" "}
          <code>main</code> / <code>production</code>. Max 3 counted pushes per day · 30 min apart.
        </li>
        <li>
          <strong>Commitment.</strong> Unlike Bankr Glidepath, vesting locks cannot be undone with a
          cooldown — tokens release only when milestones are hit.
        </li>
      </ol>

      <style>{`
        .vesting-path {
          background: linear-gradient(180deg, #faf5ff 0%, #fff 100%);
          border: 1px solid #e9d5ff;
          border-radius: 1rem;
          padding: 1.25rem 1.5rem;
          margin: 1rem 0;
        }
        .vesting-path__eyebrow {
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #7c3aed;
          font-weight: 700;
        }
        .vesting-path__header h3 { margin: 0.25rem 0 0.5rem; font-size: 1.15rem; }
        .vesting-path__summary { margin: 0; color: #4b5563; font-size: 0.9rem; max-width: 36rem; }
        .vesting-path__chart { margin: 1.25rem 0; display: flex; flex-direction: column; gap: 0.65rem; }
        .vesting-path__row {
          display: grid;
          grid-template-columns: 9rem 1fr 7rem;
          gap: 0.75rem;
          align-items: center;
        }
        .vesting-path__label { font-size: 0.85rem; font-weight: 600; }
        .vesting-path__label .muted { font-weight: 400; color: #6b7280; }
        .vesting-path__bar-wrap {
          background: #ede9fe;
          border-radius: 9999px;
          height: 0.65rem;
          overflow: hidden;
        }
        .vesting-path__bar {
          background: #c4b5fd;
          height: 100%;
          border-radius: 9999px;
          min-width: 4px;
          transition: width 0.3s;
        }
        .vesting-path__bar.reached { background: #a78bfa; }
        .vesting-path__bar.paid { background: #7c3aed; }
        .vesting-path__value { font-size: 0.85rem; font-weight: 600; text-align: right; color: #5b21b6; }
        .vesting-path__how {
          margin: 0;
          padding-left: 1.2rem;
          font-size: 0.85rem;
          color: #374151;
          line-height: 1.5;
        }
        .vesting-path__how li { margin-bottom: 0.5rem; }
        .vesting-path code {
          background: #f3f4f6;
          padding: 0.1rem 0.35rem;
          border-radius: 0.25rem;
          font-size: 0.85em;
        }
        @media (max-width: 640px) {
          .vesting-path__row { grid-template-columns: 1fr; gap: 0.25rem; }
          .vesting-path__value { text-align: left; }
        }
      `}</style>
    </div>
  );
}
