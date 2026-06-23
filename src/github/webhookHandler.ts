import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { env } from "../lib/env";
import { getGrantByRepoFullName } from "../lib/redis";
import type { PushPayload } from "./pushVerifier";
import { processPushForGrant } from "./processPush";

/** Verify GitHub's HMAC-SHA256 webhook signature. */
function verifySignature(body: Buffer, signature: string): boolean {
  const expected = "sha256=" + createHmac("sha256", env.GITHUB_WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  try {
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    const event = req.headers["x-github-event"] as string | undefined;

    if (!sig || !event) {
      res.status(400).json({ error: "Missing signature or event header" });
      return;
    }

    const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));

    if (!verifySignature(rawBody, sig)) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }

    if (event === "ping") {
      res.json({ ok: true, message: "pong" });
      return;
    }

    if (event !== "push") {
      res.json({ ok: true, message: `Event "${event}" ignored` });
      return;
    }

    const payload = req.body as PushPayload;
    const repoFullName = payload.repository?.full_name;

    if (!repoFullName) {
      res.status(400).json({ error: "Missing repository.full_name" });
      return;
    }

    const grant = await getGrantByRepoFullName(repoFullName);

    if (!grant || grant.status !== "active") {
      // No active vesting grant for this repo — ignore silently.
      res.json({ ok: true, message: "No active vesting grant for this repo" });
      return;
    }

    console.log(`[webhook] push to ${repoFullName} — evaluating`);

    const result = await processPushForGrant(grant, payload);

    if (!result.accepted) {
      console.log(`[webhook] push rejected: ${result.reason}`);
      res.json({ ok: true, accepted: false, reason: result.reason });
      return;
    }

    console.log(
      `[webhook] push accepted for ${repoFullName}: total verified pushes = ${result.verifiedPushCount}`,
    );

    res.json({
      ok: true,
      accepted: true,
      reason: result.reason,
      verifiedPushCount: result.verifiedPushCount,
      release: result.release,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[webhook] unhandled error:", err);
    res.status(500).json({ error: "Webhook handler failed", message: msg });
  }
}
