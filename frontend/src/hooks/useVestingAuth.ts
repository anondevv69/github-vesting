import { useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import type { Address } from "viem";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export type GitHubUser = {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string;
};

export function useVestingAuth() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [wallet, setWallet] = useState<Address | null>(() => {
    const saved = localStorage.getItem("vesting_wallet");
    return saved ? (saved as Address) : null;
  });
  const [githubUser, setGithubUser] = useState<GitHubUser | null>(() => {
    const saved = localStorage.getItem("vesting_github_user");
    if (!saved) return null;
    try {
      return JSON.parse(saved) as GitHubUser;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    const githubUserParam = searchParams.get("github_user");
    const oauthError = searchParams.get("error");
    if (githubUserParam) {
      try {
        const user = JSON.parse(decodeURIComponent(githubUserParam)) as GitHubUser;
        setGithubUser(user);
        localStorage.setItem("vesting_github_user", JSON.stringify(user));
      } catch { /* ignore */ }
      const next = new URLSearchParams(searchParams);
      next.delete("github_user");
      next.delete("error");
      setSearchParams(next, { replace: true });
    } else if (oauthError) {
      const next = new URLSearchParams(searchParams);
      next.delete("error");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (wallet) localStorage.setItem("vesting_wallet", wallet);
  }, [wallet]);

  async function connectWallet() {
    const eth = (window as Window & { ethereum?: { request: (args: { method: string }) => Promise<string[]> } }).ethereum;
    if (!eth) throw new Error("No wallet detected. Install MetaMask or Coinbase Wallet.");
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    if (accounts[0]) setWallet(accounts[0] as Address);
  }

  function connectGitHub() {
    const returnTo = encodeURIComponent(location.pathname + location.search);
    window.location.href = `${API_BASE}/api/oauth/github?returnTo=${returnTo}`;
  }

  function disconnectWallet() {
    localStorage.removeItem("vesting_wallet");
    setWallet(null);
  }

  function disconnectGitHub() {
    localStorage.removeItem("vesting_github_user");
    setGithubUser(null);
  }

  return {
    wallet,
    githubUser,
    connectWallet,
    connectGitHub,
    disconnectWallet,
    disconnectGitHub,
  };
}
