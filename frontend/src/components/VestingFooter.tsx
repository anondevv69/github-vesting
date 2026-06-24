import { Link } from "react-router-dom";
import { CopyButton } from "./CopyButton";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const SKILL_URL = "https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting";
const SKILL_INSTALL = "install GitHub Vesting skill at https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting";

export function VestingFooter() {
  return (
    <footer className="vesting-footer">
      <div className="vesting-footer__top">
        <span className="vesting-footer__title">For agents</span>
        <div className="vesting-footer__nav">
          <Link to="/help">Help</Link>
          <Link to="/agents">Agent guide</Link>
          <a href={`${API_BASE}/agent.md`} target="_blank" rel="noreferrer">agent.md</a>
        </div>
      </div>

      <div className="vesting-footer__cards">
        <div className="vesting-footer__card">
          <span className="vesting-footer__card-label">Bankr · @bankrbot</span>
          <p className="vesting-footer__card-desc muted">Install the skill package</p>
          <div className="vesting-footer__code">
            <code>{SKILL_INSTALL}</code>
            <CopyButton text={SKILL_INSTALL} />
          </div>
          <a href={SKILL_URL} target="_blank" rel="noreferrer" className="vesting-footer__card-link">
            Skill folder →
          </a>
        </div>

        <div className="vesting-footer__card">
          <span className="vesting-footer__card-label">Any agent</span>
          <p className="vesting-footer__card-desc muted">REST API — no skill needed</p>
          <div className="vesting-footer__code vesting-footer__code--short">
            <code>{API_BASE}/api/agent/briefing</code>
            <CopyButton text={`${API_BASE}/api/agent/briefing`} label="Copy" />
          </div>
          <Link to="/agents" className="vesting-footer__card-link">
            Full guide →
          </Link>
        </div>
      </div>
    </footer>
  );
}
