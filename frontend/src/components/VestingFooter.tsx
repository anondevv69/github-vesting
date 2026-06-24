import { Link } from "react-router-dom";
import { CopyButton } from "./CopyButton";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const SKILL_URL = "https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting";
const SKILL_INSTALL = "install GitHub Vesting skill at https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting";
const BRIEFING_URL = `${API_BASE}/api/agent/briefing`;

export function VestingFooter() {
  return (
    <footer className="vesting-footer">
      <div className="vesting-footer__header">
        <span className="vesting-footer__eyebrow">For agents</span>
        <nav className="vesting-footer__nav" aria-label="Agent resources">
          <Link to="/help">Help</Link>
          <span className="vesting-footer__dot" aria-hidden>·</span>
          <Link to="/agents">Guide</Link>
          <span className="vesting-footer__dot" aria-hidden>·</span>
          <a href={`${API_BASE}/agent.md`} target="_blank" rel="noreferrer">agent.md</a>
        </nav>
      </div>

      <div className="vesting-footer__grid">
        <article className="vesting-footer__card vesting-footer__card--bankr">
          <div className="vesting-footer__card-head">
            <span className="vesting-footer__pill vesting-footer__pill--bankr">@bankrbot</span>
            <a href={SKILL_URL} target="_blank" rel="noreferrer" className="vesting-footer__card-action">
              Skill
            </a>
          </div>
          <div className="vesting-footer__snippet">
            <code>{SKILL_INSTALL}</code>
            <CopyButton text={SKILL_INSTALL} icon />
          </div>
        </article>

        <article className="vesting-footer__card">
          <div className="vesting-footer__card-head">
            <span className="vesting-footer__pill">REST API</span>
            <Link to="/agents" className="vesting-footer__card-action">
              Guide
            </Link>
          </div>
          <div className="vesting-footer__snippet">
            <code>{BRIEFING_URL}</code>
            <CopyButton text={BRIEFING_URL} icon />
          </div>
        </article>
      </div>
    </footer>
  );
}
