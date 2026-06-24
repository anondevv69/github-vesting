import { Link } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { VestingFooter } from "../components/VestingFooter";
import { CopyButton } from "../components/CopyButton";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const SKILL_URL = "https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting";
const SKILL_INSTALL = "install GitHub Vesting skill at https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting";

const CURL_EXAMPLE = `curl -H "x-wallet-address: 0x…" "${API_BASE}/api/agent/briefing"`;

export function AgentsPage() {
  return (
    <div className="vesting-page">
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
            <CopyButton text={SKILL_INSTALL} />
          </div>

          <h3>What the skill provides</h3>
          <ul className="help-list">
            <li>Intent routing (my vesting, status on repo, start lock)</li>
            <li>Tweet-friendly <code>tweetReply</code> from the API</li>
            <li>Linked wallet via <code>x-wallet-address</code> header</li>
            <li>Setup link → <code>/create</code> · status → <code>/lock/owner/repo</code></li>
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

        <section className="vesting-card agents-card">
          <div className="agents-card__badge agents-card__badge--generic">Any agent</div>
          <h2>Regular agents &amp; custom bots</h2>
          <p className="muted">
            No skill required — call the public REST Agent API directly. Works with OpenClaw, Cursor,
            custom scripts, or any HTTP client.
          </p>

          <h3>Base URL</h3>
          <div className="agents-code-block">
            <code>{API_BASE}</code>
            <CopyButton text={API_BASE} label="Copy URL" />
          </div>

          <h3>Endpoints</h3>
          <table className="help-rules-table">
            <tbody>
              <tr><td><code>GET /api/agent/briefing</code></td><td>Wallet summary</td></tr>
              <tr><td><code>GET /api/agent/grants</code></td><td>Detailed lock list</td></tr>
              <tr><td><code>GET /api/agent/status</code></td><td>Single repo progress</td></tr>
              <tr><td><code>GET /api/agent/setup-link</code></td><td>Start lock wizard URL</td></tr>
            </tbody>
          </table>

          <h3>Example</h3>
          <div className="agents-code-block agents-code-block--wide">
            <code>{CURL_EXAMPLE}</code>
            <CopyButton text={CURL_EXAMPLE} label="Copy curl" />
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

      <VestingFooter />
    </div>
  );
}
