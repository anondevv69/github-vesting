import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { env, getMissingEnvVars } from "./lib/env";
import { handleWebhook } from "./github/webhookHandler";
import { handleRegister } from "./api/register";
import { handleStatus, handleList } from "./api/status";
import {
  handleAgentBriefing,
  handleAgentGrants,
  handleAgentStatus,
  handleAgentSetupLink,
} from "./api/agent";
import { handleBankrFeeTokens } from "./api/bankr";
import { handleGitlawbRepoLookup, handleGitlawbSetupInfo } from "./api/gitlawb";
import { handleGitlawbWebhook } from "./gitlawb/webhookHandler";
import {
  handleExplore,
  handleByToken,
  handleByDev,
  handlePostDevReview,
  handleLeaderboard,
} from "./api/explore";
import { handleGrantsByRecipient } from "./api/grants";
import { handleDevSimulatePush } from "./api/devSimulate";
import { handleOAuthRedirect, handleOAuthCallback } from "./api/oauth";

const app = express();

// ─── Raw body capture (needed for GitHub webhook signature verification) ──────
app.use(
  (req, res, next) => {
    if (req.path === "/api/webhook/github" || req.path === "/api/webhook/gitlawb") {
      let data: Buffer[] = [];
      req.on("data", (chunk: Buffer) => data.push(chunk));
      req.on("end", () => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.concat(data);
        next();
      });
    } else {
      next();
    }
  },
);

app.use(express.json());
app.use(
  cors({
    origin: env.FRONTEND_URL,
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

// ─── Vesting API ──────────────────────────────────────────────────────────────
app.post("/api/vesting/register", (req, res) => void handleRegister(req, res));
app.get("/api/vesting/grants", (req, res) => void handleGrantsByRecipient(req, res));
app.get("/api/vesting/status/:repoId", (req, res) => void handleStatus(req, res));
app.get("/api/vesting/status", (req, res) => void handleStatus(req, res));
app.get("/api/vesting/list", (req, res) => void handleList(req, res));
app.post("/api/dev/simulate-push", (req, res) => void handleDevSimulatePush(req, res));

// ─── Bankr + discovery ─────────────────────────────────────────────────────────
app.get("/api/bankr/fee-tokens", (req, res) => void handleBankrFeeTokens(req, res));
app.get("/api/gitlawb/repo", (req, res) => void handleGitlawbRepoLookup(req, res));
app.get("/api/gitlawb/setup", (req, res) => void handleGitlawbSetupInfo(req, res));
app.get("/api/vesting/explore", (req, res) => void handleExplore(req, res));
app.get("/api/vesting/by-token/:token", (req, res) => void handleByToken(req, res));
app.get("/api/vesting/by-token", (req, res) => void handleByToken(req, res));
app.get("/api/vesting/by-dev/:login", (req, res) => void handleByDev(req, res));
app.get("/api/vesting/by-dev", (req, res) => void handleByDev(req, res));
app.post("/api/vesting/by-dev/:login/reviews", (req, res) => void handlePostDevReview(req, res));
app.get("/api/vesting/leaderboard", (req, res) => void handleLeaderboard(req, res));

// ─── Bankr agent API (for @bankrbot skill) ───────────────────────────────────
app.get("/api/agent/briefing", (req, res) => void handleAgentBriefing(req, res));
app.get("/api/agent/grants", (req, res) => void handleAgentGrants(req, res));
app.get("/api/agent/status", (req, res) => void handleAgentStatus(req, res));
app.get("/api/agent/setup-link", (req, res) => void handleAgentSetupLink(req, res));

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
