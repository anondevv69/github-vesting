import { Link } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { VestingFooter } from "../components/VestingFooter";

const STEPS = [
  {
    title: "Verify your repo and wallet",
    body: (
      <>
        Install the Proof of Dev GitHub App on your repo and link your wallet. The platform checks
        server-side that the App is installed, that your GitHub login owns the repo or is an admin
        on it, and that the wallet is linked to that login. No verification, no launch — a
        self-asserted claim never counts.
      </>
    ),
  },
  {
    title: "The platform prepares your launch",
    body: (
      <>
        A per-project fee-lock vault is deployed for you from the approved implementation, and your
        fee grant is registered. Prepare-launch then re-reads every binding on-chain — repo,
        launcher, escrow, fee token, claim ledger — and checks the registered grant before it
        hands out a launch input. Wrong bindings, no input.
      </>
    ),
  },
  {
    title: "Launch through the Bankr launch SDK",
    body: (
      <>
        Your token launches through the Bankr launch SDK with the platform template below. You —
        or your agent — sign the launch from your own wallet; the SDK never takes custody of your
        keys or your funds.
      </>
    ),
  },
  {
    title: "Your supply auto-locks",
    body: (
      <>
        The locked share of your supply goes into the Proof of Dev escrow as part of the same
        flow, and the grant is stamped as a verified launch. The lock has <strong>no cancel</strong>{" "}
        and no recipient exit — it opens only as verified pushes land.
      </>
    ),
  },
  {
    title: "Ship code to unlock",
    body: (
      <>
        Counted pushes — real code on a production branch, under the anti-gaming rules — unlock
        your supply on its milestone schedule and unlock your trading fees the same way. Every
        counted merge also pays its author the platform reward token.
      </>
    ),
  },
];

const GUARANTEES = [
  {
    title: "25 / 75 fee split",
    body: (
      <>
        Of the creator slice of every trading fee, <strong>25%</strong> goes to the platform
        reward treasury — claimed WETH is recycled into the merge-reward pool — and{" "}
        <strong>75%</strong> is the launcher&apos;s, locked (see below). The Bankr pad&apos;s own
        routing comes off the total fee first; the split always applies to the creator slice,
        never to the whole trading fee.
      </>
    ),
  },
  {
    title: "Time-vesting is off",
    body: (
      <>
        Every platform launch sets Bankr time-vesting to <strong>zero, explicitly</strong>.
        Nothing unlocks by waiting for a date. Unlocking is by verified pushes, never by calendar.
      </>
    ),
  },
  {
    title: "No cancel, no exit",
    body: (
      <>
        The escrow has no cancel function and no recipient exit — not for the launcher, not for
        anyone. Tokens leave only when the oracle reports counted pushes against the schedule
        fixed at lock time.
      </>
    ),
  },
  {
    title: "Your trading fees lock too",
    body: (
      <>
        The launcher&apos;s 75% fee share does not arrive liquid. It lands in the project&apos;s
        fee-lock vault and locks into tranches that vest over the next counted pushes — a second
        supply lock that keeps refilling as the token trades.
      </>
    ),
  },
  {
    title: "Two ways to earn",
    body: (
      <>
        <strong>Build:</strong> ship on your own repo and unlock your supply and your fees.{" "}
        <strong>Review:</strong> join the reviewer swarm, check other builders&apos; pushes, and
        earn the platform reward for verifying them. A reviewer quorum gates whether a push
        counts — reviews can block a bad push, never force a release.
      </>
    ),
  },
  {
    title: "Verified work only",
    body: (
      <>
        A push counts only if it lands on a production branch with real code changes — no
        docs-only or lockfile diffs, no bot senders, no force-pushes, no duplicate commits — under
        a daily cap and a cooldown. The same rules gate locks, launches, and rewards.
      </>
    ),
  },
];

export function LaunchPage() {
  return (
    <div className="vesting-page vesting-page--wide">
      <VestingNav />

      <header>
        <h1>Launch a token</h1>
        <p className="muted">
          Deploy a token through Proof of Dev: it launches on Bankr with the platform fee
          template, its supply locks into a no-cancel escrow, and everything — supply and trading
          fees — unlocks only as you ship verified code.
        </p>
      </header>

      <section className="launch-status" role="status">
        <span className="launch-status__badge">Live on Base</span>
        <p>
          The Proof of Dev platform is deployed and live on Base: the no-cancel escrow, fee
          locking, and the verified launch pipeline are running in production, and the platform
          token <strong>POD</strong> is launched, paired with tokenized NVIDIA (NVDAc). Verified
          launches are opening in beta: connect your GitHub to start yours.
        </p>
        <div className="launch-status__actions">
          <Link to="/create" className="btn btn-sm">
            Create a lock (live)
          </Link>
          <Link to="/agents" className="btn btn-ghost btn-sm">
            Deploy with your agent →
          </Link>
        </div>
      </section>

      <section className="vesting-card launch-pod">
        <h2>Proof of Dev (POD)</h2>
        <p className="muted">Platform and reward token</p>
        <dl className="launch-pod__facts">
          <div>
            <dt>Pair</dt>
            <dd>POD / NVDAc (tokenized NVIDIA)</dd>
          </div>
          <div>
            <dt>Chain</dt>
            <dd>Base</dd>
          </div>
          <div>
            <dt>Contract</dt>
            <dd>
              <a
                href="https://basescan.org/token/0x79DDaaB608d3CbAE9480DC4f569142522922003F"
                target="_blank"
                rel="noreferrer"
                className="launch-pod__address"
              >
                0x79DDaaB608d3CbAE9480DC4f569142522922003F
              </a>
            </dd>
          </div>
        </dl>
        <p className="launch-pod__note">
          Merge rewards are paid in POD once the rewards pool is switched over and funded.
        </p>
      </section>

      <h2>How deploying works</h2>
      <div className="launch-steps">
        {STEPS.map((s, i) => (
          <article key={s.title} className="vesting-card launch-step">
            <span className="launch-step__num" aria-hidden>
              {i + 1}
            </span>
            <div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          </article>
        ))}
      </div>

      <h2>How every Proof of Dev launch works</h2>
      <p className="search-hints muted">
        These are not settings you pick — they are the platform template, identical on every
        launch, so holders and reviewers can verify any project at a glance.
      </p>
      <div className="launch-guarantees">
        {GUARANTEES.map((g) => (
          <article key={g.title} className="vesting-card launch-guarantee">
            <h3>{g.title}</h3>
            <p>{g.body}</p>
          </article>
        ))}
      </div>

      <section className="vesting-card launch-cta">
        <h2>Deploy with the ask</h2>
        <p className="muted">
          There is no launch form to fill in. Install a skill into your agent — Bankr or Claude —
          and paste it one prompt; the agent runs verification, preparation, launch, and lock end
          to end. The skills page has the install lines and the exact asks.
        </p>
        <div className="agents-card__actions">
          <Link to="/agents" className="btn btn-sm">
            Get the skills &amp; asks
          </Link>
          <Link to="/help" className="btn btn-ghost btn-sm">
            How locks work
          </Link>
        </div>
      </section>

      <VestingFooter />
    </div>
  );
}
