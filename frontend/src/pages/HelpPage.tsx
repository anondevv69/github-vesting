import { Link } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { VestingFooter } from "../components/VestingFooter";

export function HelpPage() {
  return (
    <div className="vesting-page">
      <VestingNav />

      <header>
        <h1>How GitHub vesting works</h1>
        <p className="muted">
          Lock tokens on Base, link a GitHub repo, and earn them back by shipping verified commits.
        </p>
      </header>

      <section className="vesting-card help-section">
        <h2>1. Create a lock</h2>
        <p>
          Go to <Link to="/create">Create lock</Link> and connect your wallet (fee recipient for the token)
          plus GitHub. Pick a repo, token, amount, and schedule — how many verified pushes trigger each release.
        </p>
        <p className="muted">
          Bankr tokens like Space use a streaming allowance: tokens stay in your wallet until milestones hit.
          Standard ERC-20 tokens are held in the GitEscrow contract.
        </p>
      </section>

      <section className="vesting-card help-section">
        <h2>2. Ship verified pushes</h2>
        <p>
          Push real code to your repo&apos;s default branch (<code>main</code>, <code>master</code>, or production).
          Each push is checked by the GitHub App:
        </p>
        <ul className="help-list">
          <li>Must change code files with meaningful line deltas (~10+ lines)</li>
          <li>Force-pushes and spam patterns are rejected</li>
          <li>Rate limits apply per repo</li>
        </ul>
        <p>
          Watch progress on your lock page — e.g.{" "}
          <Link to="/lock/anondevv69/github-vesting">anondevv69/github-vesting</Link>.
        </p>
      </section>

      <section className="vesting-card help-section">
        <h2>3. Get tokens back</h2>
        <p>
          When you hit a milestone (every N verified pushes), tokens release automatically on Base —
          pulled from your allowance for streaming tokens, or sent from escrow for standard locks.
        </p>
        <p>
          One-shot schedule: all tokens unlock at once when you reach the push target.
          Recurring schedule: tokens unlock in multiple payouts until the lock is complete.
        </p>
      </section>

      <section className="vesting-card help-section">
        <h2>Explore &amp; profiles</h2>
        <p>
          <Link to="/">Explore</Link> lets you search by GitHub username, repo name, token contract address,
          or X handle (if a dev linked it on their profile). Each dev has a public page at{" "}
          <code>/dev/username</code> with active locks and community feedback.
        </p>
      </section>

      <section className="vesting-card help-section">
        <h2>For agents</h2>
        <p>
          Bankr bots and terminals can install the skill from the footer, or read the{" "}
          <a href={`${import.meta.env.VITE_API_URL ?? "http://localhost:3000"}/agent.md`} target="_blank" rel="noreferrer">
            Agent API
          </a>{" "}
          for tweet-friendly status endpoints.
        </p>
      </section>

      <VestingFooter />
    </div>
  );
}
