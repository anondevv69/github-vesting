import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { env } from "../lib/env";
import { getGrant, updateGrant, KEYS, getRedis } from "../lib/redis";
import { verifyPush, recordVerifiedPush, type PushPayload } from "./pushVerifier";
import { triggerReleaseIfMilestone } from "../oracle/releaseOracle";

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

  const repoId = Buffer.from(repoFullName).toString("hex");
  const grant = await getGrant(repoId);

  if (!grant || grant.status !== "active") {
    // No active vesting grant for this repo — ignore silently.
    res.json({ ok: true, message: "No active vesting grant for this repo" });
    return;
  }

  console.log(`[webhook] push to ${repoFullName} — evaluating`);

  const verifyResult = await verifyPush(repoId, payload);

  if (!verifyResult.accepted) {
    console.log(`[webhook] push rejected: ${verifyResult.reason}`);
    res.json({ ok: true, accepted: false, reason: verifyResult.reason });
    return;
  }

  const newPushCount = await recordVerifiedPush(repoId, payload, verifyResult);
  await updateGrant(repoId, { verifiedPushCount: newPushCount });

  console.log(
    `[webhook] push accepted for ${repoFullName}: total verified pushes = ${newPushCount}`,
  );

  // Check if a new milestone was hit and trigger on-chain release.
  const releaseResult = await triggerReleaseIfMilestone(repoId, grant, newPushCount);

  res.json({
    ok: true,
    accepted: true,
    reason: verifyResult.reason,
    verifiedPushCount: newPushCount,
    release: releaseResult,
  });
}
