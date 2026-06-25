import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { env, getMissingEnvVars, getAllowedCorsOrigins } from "./lib/env";
import { handleWebhook } from "./github/webhookHandler";
import { handleRegister } from "./api/register";
import { handleStatus, handleList } from "./api/status";
import {
  handleAgentBriefing,
  handleAgentGrants,
  handleAgentStatus,
  handleAgentSetupLink,
} from "./api/agent";
import { handleAgentLinkGithub, handleInspectGithubMagicLink } from "./api/githubMagicLink";
import {
  handleAgentFeeTokens,
  handleAgentPrepareLock,
  handleAgentConfirmLock,
  handleAgentLock,
} from "./api/agentLock";
import { handleBankrFeeTokens, handleBankrTokenInfo } from "./api/bankr";
import { handleGitlawbRepoLookup, handleGitlawbSetupInfo } from "./api/gitlawb";
import { handleGitlawbWebhook } from "./gitlawb/webhookHandler";
import {
  handleExplore,
  handleByToken,
  handleByDev,
  handlePostDevReview,
  handleLeaderboard,
} from "./api/explore";
import { handleSearch, handleRecentPushes, handleLockDetail } from "./api/discovery";
import { handleGetDevProfile, handlePatchDevProfile } from "./api/devProfile";
import {
  handleListLinkedWallets,
  handleWalletLinkChallenge,
  handleWalletLinkConfirm,
} from "./api/devWallets";
import { handleGrantsByRecipient } from "./api/grants";
import { handleDevSimulatePush } from "./api/devSimulate";
import { handleOAuthRedirect, handleOAuthCallback } from "./api/oauth";
import {
  handleRepoClaimChallenge,
  handleRepoClaimPrepareFile,
  handleRepoClaimStatus,
  handleRepoClaimGet,
} from "./api/repoClaims";
import { handleGithubRepoLookup, handleGithubReposList } from "./api/githubRepo";
import { handleGithubAuthMe, handleGithubAuthLogout } from "./api/githubAuth";
import { handleGithubInstallationLookup } from "./api/githubInstall";

const app = express();

const WEBHOOK_PATHS = new Set(["/api/webhook/github", "/api/webhook/gitlawb"]);

function isWebhookPath(path: string): boolean {
  return WEBHOOK_PATHS.has(path);
}

// ─── Raw body capture (needed for GitHub webhook signature verification) ──────
app.use(
  (req, res, next) => {
    if (!isWebhookPath(req.path)) {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", next);
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      (req as express.Request & { rawBody?: Buffer }).rawBody = rawBody;
      try {
        req.body = JSON.parse(rawBody.toString("utf8")) as unknown;
      } catch {
        req.body = {};
      }
      next();
    });
  },
);

const allowedOrigins = getAllowedCorsOrigins();

app.use((req, res, next) => {
  if (isWebhookPath(req.path)) {
    next();
    return;
  }
  express.json()(req, res, next);
});
app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server / curl (no Origin header)
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, origin);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "x-wallet-address", "x-client"],
  }),
);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  const missing = getMissingEnvVars();
  res.json({
    ok: true,
    service: "github-vesting",
    configured: missing.length === 0,
    ...(missing.length ? { missingEnv: missing } : {}),
    ts: new Date().toISOString(),
  });
});

app.get("/agent.md", (_req, res) => {
  const docPath = path.join(__dirname, "..", "docs", "agent.md");
  try {
    res.type("text/markdown").send(fs.readFileSync(docPath, "utf8"));
  } catch {
    res.status(404).type("text/plain").send("agent.md not found");
  }
});

// ─── GitHub webhook (receives push events from installed repos) ───────────────
app.post("/api/webhook/github", (req, res) => void handleWebhook(req, res));
app.post("/api/webhook/gitlawb", (req, res) => void handleGitlawbWebhook(req, res));

// ─── OAuth ────────────────────────────────────────────────────────────────────
app.get("/api/oauth/github", handleOAuthRedirect);
app.get("/api/oauth/github/callback", (req, res) => void handleOAuthCallback(req, res));
app.get("/api/link-github/inspect", (req, res) => void handleInspectGithubMagicLink(req, res));
app.get("/api/auth/github/me", (req, res) => void handleGithubAuthMe(req, res));
app.post("/api/auth/github/logout", (req, res) => void handleGithubAuthLogout(req, res));
app.get("/api/github/installation", (req, res) => void handleGithubInstallationLookup(req, res));
app.post("/api/repo-claims/challenge", (req, res) => void handleRepoClaimChallenge(req, res));
app.post("/api/repo-claims/prepare-file", (req, res) => void handleRepoClaimPrepareFile(req, res));
app.get("/api/repo-claims/status", (req, res) => void handleRepoClaimStatus(req, res));
app.get("/api/repo-claims/:owner/:repoName", (req, res) => void handleRepoClaimGet(req, res));
app.get("/api/github/repo", (req, res) => void handleGithubRepoLookup(req, res));
app.get("/api/github/repos", (req, res) => void handleGithubReposList(req, res));

// ─── Vesting API ──────────────────────────────────────────────────────────────
app.post("/api/vesting/register", (req, res) => void handleRegister(req, res));
app.get("/api/vesting/grants", (req, res) => void handleGrantsByRecipient(req, res));
app.get("/api/vesting/status/:repoId", (req, res) => void handleStatus(req, res));
app.get("/api/vesting/status", (req, res) => void handleStatus(req, res));
app.get("/api/vesting/list", (req, res) => void handleList(req, res));
app.post("/api/dev/simulate-push", (req, res) => void handleDevSimulatePush(req, res));

// ─── Bankr + discovery ─────────────────────────────────────────────────────────
app.get("/api/bankr/fee-tokens", (req, res) => void handleBankrFeeTokens(req, res));
app.get("/api/bankr/token-info", (req, res) => void handleBankrTokenInfo(req, res));
app.get("/api/gitlawb/repo", (req, res) => void handleGitlawbRepoLookup(req, res));
app.get("/api/gitlawb/setup", (req, res) => void handleGitlawbSetupInfo(req, res));
app.get("/api/vesting/explore", (req, res) => void handleExplore(req, res));
app.get("/api/vesting/search", (req, res) => void handleSearch(req, res));
app.get("/api/vesting/recent-pushes", (req, res) => void handleRecentPushes(req, res));
app.get("/api/vesting/lock/:owner/:repoName", (req, res) => void handleLockDetail(req, res));
app.get("/api/vesting/lock", (req, res) => void handleLockDetail(req, res));
app.get("/api/vesting/by-token/:token", (req, res) => void handleByToken(req, res));
app.get("/api/vesting/by-token", (req, res) => void handleByToken(req, res));
app.get("/api/vesting/by-dev/:login", (req, res) => void handleByDev(req, res));
app.get("/api/vesting/by-dev", (req, res) => void handleByDev(req, res));
app.get("/api/vesting/dev-profile/:login", (req, res) => void handleGetDevProfile(req, res));
app.patch("/api/vesting/dev-profile/:login", (req, res) => void handlePatchDevProfile(req, res));
app.get("/api/dev/link-wallet/:login", (req, res) => void handleListLinkedWallets(req, res));
app.post("/api/dev/link-wallet/challenge", (req, res) => void handleWalletLinkChallenge(req, res));
app.post("/api/dev/link-wallet/confirm", (req, res) => void handleWalletLinkConfirm(req, res));
app.post("/api/vesting/by-dev/:login/reviews", (req, res) => void handlePostDevReview(req, res));
app.get("/api/vesting/leaderboard", (req, res) => void handleLeaderboard(req, res));

// ─── Bankr agent API (for @bankrbot skill) ───────────────────────────────────
app.get("/api/agent/briefing", (req, res) => void handleAgentBriefing(req, res));
app.get("/api/agent/grants", (req, res) => void handleAgentGrants(req, res));
app.get("/api/agent/status", (req, res) => void handleAgentStatus(req, res));
app.get("/api/agent/setup-link", (req, res) => void handleAgentSetupLink(req, res));
app.get("/api/agent/fee-tokens", (req, res) => void handleAgentFeeTokens(req, res));
app.post("/api/agent/prepare-lock", (req, res) => void handleAgentPrepareLock(req, res));
app.post("/api/agent/confirm-lock", (req, res) => void handleAgentConfirmLock(req, res));
app.post("/api/agent/lock", (req, res) => void handleAgentLock(req, res));
app.post("/api/agent/link-github", (req, res) => void handleAgentLinkGithub(req, res));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(env.PORT, env.HOST, () => {
  const missing = getMissingEnvVars();
  console.log(`[github-vesting] Server running on ${env.HOST}:${env.PORT}`);
  if (missing.length) {
    console.warn(`[github-vesting] Missing env vars (API features limited): ${missing.join(", ")}`);
  }
  console.log(`[github-vesting] Webhook URL: ${env.SERVER_URL}/api/webhook/github`);
  console.log(`[github-vesting] GitLawb webhook: ${env.SERVER_URL}/api/webhook/gitlawb`);
  console.log(`[github-vesting] Agent API: ${env.SERVER_URL}/api/agent/briefing`);
});

export default app;
