import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { VestingNav } from "../components/VestingNav";
import { VestingFooter } from "../components/VestingFooter";
import { shortAddr } from "../lib/format";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type InspectResponse = {
  ok?: boolean;
  error?: string;
  githubLogin?: string;
  wallet?: string;
  expiresAt?: string;
  profileUrl?: string;
  oauthUrl?: string;
};

export function LinkGithubPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("t") ?? "";
  const errorParam = searchParams.get("error");
  const [loading, setLoading] = useState(true);
  const [inspect, setInspect] = useState<InspectResponse | null>(null);
  const [error, setError] = useState<string | null>(errorParam);

  useEffect(() => {
    if (errorParam) setError(errorParam);
  }, [errorParam]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError("Missing link token — ask @bankrbot for a new link.");
      return;
    }

    setLoading(true);
    fetch(`${API_BASE}/api/link-github/inspect?t=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json() as InspectResponse;
        if (!res.ok || !data.ok) {
          throw new Error(data.error ?? "Invalid or expired link");
        }
        setInspect(data);
        setError(null);
      })
      .catch((e) => {
        setInspect(null);
        setError(e instanceof Error ? e.message : "Could not load link");
      })
      .finally(() => setLoading(false));
  }, [token]);

  const expiresLabel = inspect?.expiresAt
    ? new Date(inspect.expiresAt).toLocaleTimeString()
    : null;

  return (
    <div className="vesting-page">
      <VestingNav />

      <header>
        <h1>Link Bankr wallet to GitHub</h1>
        <p className="muted">
          One-time secure link from @bankrbot. Sign in with GitHub to verify your account.
        </p>
      </header>

      {loading && <p className="muted">Checking link…</p>}

      {!loading && error && (
        <div className="vesting-card">
          <p className="err">{error}</p>
          <p className="muted">
            In Bankr chat or on X, ask: <code>link github @yourusername</code>
          </p>
        </div>
      )}

      {!loading && inspect?.ok && inspect.githubLogin && inspect.wallet && (
        <div className="vesting-card">
          <p>
            Link wallet <code>{shortAddr(inspect.wallet)}</code> to GitHub{" "}
            <strong>@{inspect.githubLogin}</strong>
          </p>
          {expiresLabel && (
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Link expires at {expiresLabel}. Do not share this URL.
            </p>
          )}
          <p className="muted">
            You must sign in with GitHub as <strong>@{inspect.githubLogin}</strong>.
            Other accounts will be rejected.
          </p>
          <a
            className="btn btn-primary"
            href={inspect.oauthUrl ?? `${API_BASE}/api/oauth/github?linkToken=${token}`}
          >
            Continue with GitHub
          </a>
          <p className="muted" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
            After linking, your dev profile will show this wallet under Linked wallets — even when
            you connect a different wallet in the browser.
          </p>
          {inspect.profileUrl && (
            <p style={{ marginTop: "0.75rem" }}>
              <Link to={`/dev/${inspect.githubLogin}`}>View profile</Link>
            </p>
          )}
        </div>
      )}

      <VestingFooter />
    </div>
  );
}
