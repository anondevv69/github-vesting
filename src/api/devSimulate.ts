/**
 * POST /api/dev/simulate-push  (development only)
 * Body: { repoFullName: "owner/repo", count?: number }
 *
 * Simulates verified GitHub pushes for local testing without webhooks.
 */

import type { Request, Response } from "express";
import { getGrantByRepoFullName } from "../lib/redis";
import { buildDevPushPayload, processPushForGrant } from "../github/processPush";

export async function handleDevSimulatePush(req: Request, res: Response): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ ok: false, error: "Not found" });
    return;
  }

  const repoFullName = String(req.body?.repoFullName ?? "");
  const count = Math.min(Number(req.body?.count ?? 1), 5);

  if (!repoFullName) {
    res.status(400).json({ ok: false, error: "repoFullName required" });
    return;
  }

  const grant = await getGrantByRepoFullName(repoFullName);
  if (!grant || grant.status !== "active") {
    res.status(404).json({ ok: false, error: "No active grant for this repo" });
    return;
  }

  const results = [];
  for (let i = 0; i < count; i++) {
    const payload = buildDevPushPayload(repoFullName, `devsim${Date.now()}${i}`.padEnd(40, "0").slice(0, 40));
    const result = await processPushForGrant(grant, payload, { bypassCooldown: i > 0 });
    results.push(result);
    if (result.verifiedPushCount !== undefined) {
      grant.verifiedPushCount = result.verifiedPushCount;
      if (result.release && "triggered" in result.release && result.release.triggered) {
        grant.lastPaidMilestone = Math.floor(result.verifiedPushCount / grant.pushesPerMilestone);
      }
    }
  }

  res.json({ ok: true, results });
}
