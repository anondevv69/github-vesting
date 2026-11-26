import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { env } from "../lib/env";
import { getGrantByRepoFullName } from "../lib/redis";
import type { PushPayload } from "./pushVerifier";
import { isClaimOnlyPush } from "../lib/repoClaims";
import { processRepoClaimFromPush } from "./repoClaimHandler";
import { processPushForGrant, processPushGrantless } from "./processPush";
import { resolveShipReport, recordPushSettlement } from "../api/shipReport";

/** Head SHA of the push (GitHub `after`, else the last commit's id). */
function pushHeadSha(payload: PushPayload): string | null {
  if (payload.after) return payload.after.toLowerCase();
  const commits = payload.commits ?? [];
  const last = commits[commits.length - 1];
  return last?.id ? last.id.toLowerCase() : null;
}

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

    const claimResult = await processRepoClaimFromPush(payload);

    const grant = await getGrantByRepoFullName(repoFullName);

    if (claimResult.processed && !grant) {
      res.json({
        ok: true,
        repoClaim: claimResult,
        message: claimResult.verified
          ? "Repo claim verified"
          : `Repo claim push processed: ${claimResult.reason}`,
      });
      return;
    }

    if (!grant || grant.status !== "active") {
      if (claimResult.processed) {
        res.json({ ok: true, repoClaim: claimResult, message: "Repo claim processed; no active vesting grant" });
        return;
      }

      if (isClaimOnlyPush(payload.commits ?? [])) {
        await resolveShipReport(repoFullName, pushHeadSha(payload), {
          kind: "rejected",
          reason: "Repo claim verification push — not counted toward vesting",
        });
        res.json({
          ok: true,
          accepted: false,
          grantless: true,
          reason: "Repo claim verification push — not counted toward vesting",
        });
        return;
      }

      // Grant-less rewards (audit H1): the App is installed (it webhook'd
      // us) but no grant exists — pushes are still verified with the full
      // anti-gaming rules, and a counted merged PR earns its author the
      // per-merge reward. There is no unlock; nothing is locked.
      console.log(`[webhook] push to ${repoFullName} — evaluating (grant-less: rewards only)`);

      const result = await processPushGrantless(repoFullName, payload);

      if (!result.accepted) {
        await resolveShipReport(repoFullName, pushHeadSha(payload), {
          kind: "rejected",
          reason: result.reason,
        });
        console.log(`[webhook] grant-less push rejected: ${result.reason}`);
        res.json({ ok: true, accepted: false, grantless: true, reason: result.reason });
        return;
      }

      // Attestation layer: grant-less reports resolve only on an actual
      // reward payment (→ paid) or a rejection (above). A counted push
      // whose reward accrued as pending (author unlinked) or is
      // unconfigured leaves the report open — there is no grant progress
      // to "confirm"; it reads expired after 24h, or flips to paid if
      // settlement lands when the author links a wallet.
      const reward = result.reward;
      if (reward?.paid) {
        // Record the settlement evidence too: a report filed AFTER this
        // webhook reconciles from it and can honestly read "paid".
        await recordPushSettlement(repoFullName, pushHeadSha(payload), {
          rewardTxHash: reward.txHash,
          rewardRecipient: reward.recipient,
          rewardAmount: reward.amount,
        });
        await resolveShipReport(repoFullName, pushHeadSha(payload), {
          kind: "counted",
          reason: result.reason,
          ...(result.verifiedPushCount !== undefined
            ? { verifiedPushCount: result.verifiedPushCount }
            : {}),
          rewardTxHash: reward.txHash,
          rewardRecipient: reward.recipient,
          rewardAmount: reward.amount,
        });
      }

      console.log(
        `[webhook] grant-less push accepted for ${repoFullName}: total verified pushes = ${result.verifiedPushCount}`,
      );

      res.json({
        ok: true,
        accepted: true,
        grantless: true,
        reason: result.reason,
        verifiedPushCount: result.verifiedPushCount,
        ...(result.prCredit ? { prCredit: result.prCredit } : {}),
        ...(result.reward ? { reward: result.reward } : {}),
      });
      return;
    }

    if (isClaimOnlyPush(payload.commits ?? [])) {
      await resolveShipReport(repoFullName, pushHeadSha(payload), {
        kind: "rejected",
        reason: "Repo claim verification push — not counted toward vesting",
      });
      res.json({
        ok: true,
        accepted: false,
        reason: "Repo claim verification push — not counted toward vesting",
        repoClaim: claimResult.processed ? claimResult : undefined,
      });
      return;
    }

    console.log(`[webhook] push to ${repoFullName} — evaluating`);

    const result = await processPushForGrant(grant, payload);

    // Attestation layer: resolve any matching ship report with the real
    // outcome. Pure bookkeeping — the response below is unchanged, and
    // resolveShipReport can never throw into this flow.
    if (!result.accepted) {
      await resolveShipReport(repoFullName, pushHeadSha(payload), {
        kind: "rejected",
        reason: result.reason,
      });
    } else {
      const release = result.release;
      const releaseTxHash =
        release && release.triggered ? release.txHash : undefined;
      const reward = result.reward;
      // Record the settlement evidence too: a report filed AFTER this
      // webhook reconciles from it and can honestly read "paid".
      if (releaseTxHash || reward?.paid) {
        await recordPushSettlement(repoFullName, pushHeadSha(payload), {
          ...(releaseTxHash ? { releaseTxHash } : {}),
          ...(release && release.triggered && release.milestone !== undefined
            ? { milestone: release.milestone }
            : {}),
          ...(reward?.paid
            ? {
                rewardTxHash: reward.txHash,
                rewardRecipient: reward.recipient,
                rewardAmount: reward.amount,
              }
            : {}),
        });
      }
      await resolveShipReport(repoFullName, pushHeadSha(payload), {
        kind: "counted",
        reason: result.reason,
        ...(result.verifiedPushCount !== undefined
          ? { verifiedPushCount: result.verifiedPushCount }
          : {}),
        ...(releaseTxHash ? { releaseTxHash } : {}),
        ...(release && release.triggered && release.milestone !== undefined
          ? { milestone: release.milestone }
          : {}),
        ...(reward?.paid
          ? {
              rewardTxHash: reward.txHash,
              rewardRecipient: reward.recipient,
              rewardAmount: reward.amount,
            }
          : {}),
      });
    }

    if (!result.accepted) {
      console.log(`[webhook] push rejected: ${result.reason}`);
      res.json({
        ok: true,
        accepted: false,
        reason: result.reason,
        ...(result.swarm ? { swarm: result.swarm } : {}),
      });
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
      ...(result.prCredit ? { prCredit: result.prCredit } : {}),
      ...(result.reward ? { reward: result.reward } : {}),
      ...(result.swarm ? { swarm: result.swarm } : {}),
      ...(claimResult.processed ? { repoClaim: claimResult } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[webhook] unhandled error:", err);
    res.status(500).json({ error: "Webhook handler failed", message: msg });
  }
}
