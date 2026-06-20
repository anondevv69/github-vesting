import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { env } from "../lib/env";
import { getGrantByRepoFullName } from "../lib/redis";
import { gitlawbRepoFullNameFromWebhook, type GitlawbPushWebhook } from "./client";
import { gitlawbToPushPayload } from "./pushAdapter";
import { processPushForGrant } from "../github/processPush";

function verifySignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret) return env.NODE_ENV !== "production";
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function handleGitlawbWebhook(req: Request, res: Response): Promise<void> {
  const event = req.headers["x-gitlawb-event"] as string | undefined;
  const sig = req.headers["x-gitlawb-signature-256"] as string | undefined;
  const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));

  if (!event) {
    res.status(400).json({ error: "Missing X-Gitlawb-Event header" });
    return;
  }

  if (event !== "push") {
    res.json({ ok: true, message: `Event "${event}" ignored` });
    return;
  }

  const secret = env.GITLAWB_WEBHOOK_SECRET;
  if (secret && !verifySignature(rawBody, sig, secret)) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  const payload = req.body as GitlawbPushWebhook;
  const repoFullName = gitlawbRepoFullNameFromWebhook(payload);

  if (!repoFullName) {
    res.status(400).json({ error: "Missing repository metadata in payload" });
    return;
  }

  const grant = await getGrantByRepoFullName(repoFullName, "gitlawb");
  if (!grant || grant.status !== "active") {
    res.json({ ok: true, message: "No active vesting grant for this GitLawb repo" });
    return;
  }

  console.log(`[gitlawb-webhook] push to ${repoFullName} (${payload.after?.slice(0, 7)})`);

  const pushPayload = gitlawbToPushPayload(payload, repoFullName);
  const result = await processPushForGrant(grant, pushPayload, { platform: "gitlawb" });

  if (!result.accepted) {
    console.log(`[gitlawb-webhook] push rejected: ${result.reason}`);
    res.json({ ok: true, accepted: false, reason: result.reason });
    return;
  }

  res.json({
    ok: true,
    accepted: true,
    reason: result.reason,
    verifiedPushCount: result.verifiedPushCount,
    release: result.release,
  });
}
