import express from "express";
import cors from "cors";
import { env } from "./lib/env";
import { handleWebhook } from "./github/webhookHandler";
import { handleRegister } from "./api/register";
import { handleStatus, handleList } from "./api/status";
import { handleOAuthRedirect, handleOAuthCallback } from "./api/oauth";

const app = express();

// ─── Raw body capture (needed for GitHub webhook signature verification) ──────
app.use(
  (req, res, next) => {
    let data: Buffer[] = [];
    req.on("data", (chunk: Buffer) => data.push(chunk));
    req.on("end", () => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.concat(data);
      next();
    });
  },
);

app.use(express.json());
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
  }),
);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "github-vesting", ts: new Date().toISOString() });
});

// ─── GitHub webhook (receives push events from installed repos) ───────────────
app.post("/api/webhook/github", (req, res) => void handleWebhook(req, res));

// ─── OAuth ────────────────────────────────────────────────────────────────────
app.get("/api/oauth/github", handleOAuthRedirect);
app.get("/api/oauth/github/callback", (req, res) => void handleOAuthCallback(req, res));

// ─── Vesting API ──────────────────────────────────────────────────────────────
app.post("/api/vesting/register", (req, res) => void handleRegister(req, res));
app.get("/api/vesting/status/:repoId", (req, res) => void handleStatus(req, res));
app.get("/api/vesting/status", (req, res) => void handleStatus(req, res));
app.get("/api/vesting/list", (req, res) => void handleList(req, res));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(env.PORT, () => {
  console.log(`[github-vesting] Server running on port ${env.PORT}`);
  console.log(`[github-vesting] Webhook URL: ${env.FRONTEND_URL}/api/webhook/github`);
});

export default app;
