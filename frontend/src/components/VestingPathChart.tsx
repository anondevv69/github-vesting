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

      <div className="vesting-path__rules">
        <div className="vesting-path__rule">
          <strong>One push = one count</strong>
          A single commit to <code>main</code> counts once. Re-pushing the same SHA does not double-count.
        </div>
        <div className="vesting-path__rule">
          <strong>Meaningful code</strong>
          ≥3 lines of real code (not docs/lockfiles) on <code>main</code>. Max 3/day · 30 min apart.
        </div>
        <div className="vesting-path__rule">
          <strong>Commitment</strong>
          Unlike Glidepath, vesting locks cannot be undone — tokens release only at milestones.
        </div>
      </div>
    </div>
  );
}
