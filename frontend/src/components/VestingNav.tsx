import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useVestingAuth } from "../hooks/useVestingAuth";

const links = [
  { to: "/", label: "Explore" },
  { to: "/create", label: "Create lock" },
  { to: "/help", label: "Help" },
  { to: "/agents", label: "Agents" },
];

export function VestingNav() {
  const { pathname } = useLocation();
  const { wallet, githubUser, connectWallet, connectGitHub, disconnectWallet, disconnectGitHub } = useVestingAuth();
  const [authError, setAuthError] = useState<string | null>(null);

  return (
    <nav className="vesting-nav">
      <Link to="/" className="vesting-nav__brand">
        GitHub Vesting
      </Link>
      <div className="vesting-nav__links">
        {links.map(({ to, label }) => (
          <Link
            key={to}
            to={to}
            className={pathname === to || (to !== "/" && pathname.startsWith(to)) ? "active" : ""}
          >
            {label}
          </Link>
        ))}
      </div>
      <div className="vesting-nav__auth">
        {githubUser ? (
          <Link to={`/dev/${githubUser.login}`} className="vesting-nav__user">
            <img src={githubUser.avatarUrl} alt="" width={22} height={22} className="vesting-nav__avatar" />
            @{githubUser.login}
          </Link>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => connectGitHub()}
          >
            Connect GitHub
          </button>
        )}
        {wallet ? (
          <span className="vesting-nav__wallet">
            <code>{wallet.slice(0, 6)}…{wallet.slice(-4)}</code>
            <button type="button" className="btn-link muted" onClick={disconnectWallet} title="Disconnect wallet">
              ×
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setAuthError(null);
              void connectWallet().catch((e) =>
                setAuthError(e instanceof Error ? e.message : "Wallet connect failed"),
              );
            }}
          >
            Connect wallet
          </button>
        )}
        {(githubUser || wallet) && (
          <details className="vesting-nav__menu">
            <summary className="muted">Account</summary>
            <div className="vesting-nav__menu-body">
              {githubUser && (
                <button type="button" className="btn-link" onClick={disconnectGitHub}>
                  Disconnect GitHub
                </button>
              )}
              {wallet && (
                <button type="button" className="btn-link" onClick={disconnectWallet}>
                  Disconnect wallet
                </button>
              )}
              {githubUser && (
                <Link to={`/dev/${githubUser.login}`}>My profile</Link>
              )}
            </div>
          </details>
        )}
      </div>
      {authError && <p className="vesting-nav__err err">{authError}</p>}
    </nav>
  );
}
