import { Link } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { VestingFooter } from "../components/VestingFooter";
import { CopyButton } from "../components/CopyButton";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const SKILL_URL = "https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting";
const SKILL_INSTALL = "install GitHub Vesting skill at https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting";
const SKILL_INSTALL_MIRROR = "install the github-vesting skill from https://github.com/BankrBot/skills/tree/main/github-vesting";
const CLAUDE_SKILL_URL = "https://github.com/anondevv69/github-vesting/tree/main/skills/claude-vesting";
const CLAUDE_SKILL_INSTALL = "install the Proof of Dev skill from https://github.com/anondevv69/github-vesting/tree/main/skills/claude-vesting";

const CURL_EXAMPLE = `curl -H "x-wallet-address: 0x…" "${API_BASE}/api/agent/briefing"`;

const ASKS = [
  {
    label: "Launch a token",
    text: "Install the Proof of Dev skill and launch my token for github.com/<owner>/<repo> through Proof of Dev.",
  },
  {
    label: "Lock an existing token",
    text: "Lock 100,000 of my token against my repo so it unlocks as I ship.",
  },
  {
    label: "Status & rewards",
    text: "Check my vesting progress and what my last merge earned.",
  },
  {
    label: "Earn by reviewing",
    text: "Join the Proof of Dev reviewer swarm and verify other builders' pushes so I earn reviewer rewards.",
  },
];

export function AgentsPage() {
  return (
    <div className="vesting-page vesting-page--wide">
      <VestingNav />

      <header>
        <h1>For agents</h1>
        <p className="muted">
          Integrate GitHub vesting into your bot or terminal. Pick the path that matches your stack.
        </p>
      </header>

      <div className="agents-grid">
        <section className="vesting-card agents-card agents-card--bankr">
          <div className="agents-card__badge">Bankr</div>
          <h2>@bankrbot &amp; Bankr terminals</h2>
          <p className="muted">
            Load the skill package so Bankr agents know how to route vesting questions, call the API,
            and paste setup links on X.
          </p>

          <h3>Install</h3>
          <div className="agents-code-block">
            <code>{SKILL_INSTALL}</code>
            <CopyButton text={SKILL_INSTALL} icon />
          </div>
          <p className="muted agents-note">
            Also mirrored in Bankr&apos;s own skill registry:
          </p>
          <div className="agents-code-block">
            <code>{SKILL_INSTALL_MIRROR}</code>
            <CopyButton text={SKILL_INSTALL_MIRROR} icon />
          </div>

          <h3>What the skill provides</h3>
          <ul className="help-list">
            <li>Intent routing (my vesting, status on repo, lock tokens on a repo)</li>
            <li>Full lock flow: prepare txs → Bankr submit → confirm-lock</li>
            <li>Tweet-friendly <code>tweetReply</code> from the API</li>
            <li>Linked wallet via <code>x-wallet-address</code> header</li>
            <li>Web fallback → <code>/create</code> · status → <code>/lock/owner/repo</code></li>
          </ul>

          <div className="agents-card__actions">
            <a href={SKILL_URL} target="_blank" rel="noreferrer" className="btn btn-sm">
              Skill folder on GitHub
            </a>
            <a href={`${API_BASE}/agent.md`} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              agent.md (raw)
            </a>
          </div>
        </section>

        <section className="vesting-card agents-card agents-card--claude">
          <div className="agents-card__badge agents-card__badge--claude">Claude</div>
          <h2>Claude Code &amp; Muse agents</h2>
          <p className="muted">
            The Proof of Dev skill for Claude agents — the full gated launch flow, vesting status,
            and merge rewards over the same Agent API. Claude has no built-in wallet; the skill
            routes signing through your wallet tooling, Bankr, or a hand-off to you.
          </p>

          <h3>Install</h3>
          <div className="agents-code-block">
            <code>{CLAUDE_SKILL_INSTALL}</code>
            <CopyButton text={CLAUDE_SKILL_INSTALL} icon />
          </div>

          <h3>What the skill provides</h3>
          <ul className="help-list">
            <li>Step 0 GitHub App verification — required before any launch or lock prep</li>
            <li>Platform launch: verify → prepare → launch → auto-lock → register</li>
            <li>Lock flow: prepare txs → sign → confirm-lock</li>
            <li>ShipRewards: what a counted merge earned, pending rewards on link</li>
            <li>Ship reports (attestation) and reviewer-swarm enrolment</li>
          </ul>

          <div className="agents-card__actions">
            <a href={CLAUDE_SKILL_URL} target="_blank" rel="noreferrer" className="btn btn-sm">
              Skill folder on GitHub
            </a>
            <a href={`${API_BASE}/agent.md`} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              agent.md (raw)
            </a>
          </div>
        </section>

        <section className="vesting-card agents-card agents-card--wide">
          <div className="agents-card__badge agents-card__badge--generic">Any agent</div>
          <h2>Regular agents &amp; custom bots</h2>
          <p className="muted">
            No skill required — call the public REST Agent API directly. Works with OpenClaw, Cursor,
            custom scripts, or any HTTP client. The canonical protocol guide is{" "}
            <a href={`${API_BASE}/agent.md`} target="_blank" rel="noreferrer">
              agent.md
            </a>{" "}
            — an agent should fetch it before its first session.
          </p>

          <h3>Base URL</h3>
          <div className="agents-code-block">
            <code>{API_BASE}</code>
            <CopyButton text={API_BASE} icon label="Copy URL" />
          </div>

          <h3>Endpoints</h3>
          <table className="help-rules-table">
            <tbody>
              <tr><td><code>GET /api/agent/briefing</code></td><td>Wallet summary</td></tr>
              <tr><td><code>GET /api/agent/grants</code></td><td>Detailed lock list</td></tr>
              <tr><td><code>GET /api/agent/status</code></td><td>Single repo progress</td></tr>
              <tr><td><code>GET /api/agent/setup-link</code></td><td>Start lock wizard URL</td></tr>
              <tr><td><code>POST /api/agent/lock</code></td><td>Prepare approve + lock txs</td></tr>
              <tr><td><code>POST /api/agent/confirm-lock</code></td><td>Register after on-chain lock</td></tr>
            </tbody>
          </table>

          <h3>Example</h3>
          <div className="agents-code-block agents-code-block--wide">
            <code>{CURL_EXAMPLE}</code>
            <CopyButton text={CURL_EXAMPLE} icon label="Copy curl" />
          </div>
          <p className="muted agents-note">
            Pass <code>?wallet=0x…</code> or header <code>x-wallet-address: 0x…</code>.
            Responses include <code>replyText</code> for display.
          </p>

          <div className="agents-card__actions">
            <a href={`${API_BASE}/agent.md`} target="_blank" rel="noreferrer" className="btn btn-sm">
              Full agent.md
            </a>
            <Link to="/help" className="btn btn-ghost btn-sm">Human help</Link>
          </div>
        </section>
      </div>

      <h2 id="asks">Deploy with the ask</h2>
      <p className="search-hints muted">
        Once a skill is installed, you don&apos;t run the steps yourself — you ask. Paste one of
        these prompts to your own agent and it does the work end to end: verification, preparation,
        signing, and confirmation. The platform is deployed and live on Base, and the platform
        token POD is launched; verified launches are opening in beta, and locks, status, and
        rewards work today.
      </p>
      <div className="asks-list">
        {ASKS.map((a) => (
          <div key={a.label} className="ask-item">
            <span className="ask-item__label">{a.label}</span>
            <div className="agents-code-block">
              <code>{a.text}</code>
              <CopyButton text={a.text} icon label={`Copy ask: ${a.label}`} />
            </div>
          </div>
        ))}
      </div>

      <VestingFooter />
    </div>
  );
}
