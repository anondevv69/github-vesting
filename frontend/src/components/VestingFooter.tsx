const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const SKILL_URL = "https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting";
const SKILL_INSTALL = "install GitHub Vesting skill at https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting";

export function VestingFooter() {
  return (
    <footer className="vesting-footer">
      <div className="vesting-footer__links">
        <a href="/help">Help</a>
        <a href={`${API_BASE}/agent.md`} target="_blank" rel="noreferrer">
          Agent API
        </a>
        <a href={SKILL_URL} target="_blank" rel="noreferrer">
          Bankr skill
        </a>
      </div>
      <p className="vesting-footer__hint muted">
        Agents: paste{" "}
        <code className="vesting-footer__cmd">{SKILL_INSTALL}</code>
      </p>
    </footer>
  );
}
