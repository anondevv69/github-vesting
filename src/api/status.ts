/**
 * GET /api/vesting/status/:repoId
 * GET /api/vesting/status?repo=owner/repo
 *
 * Returns the current vesting state for a repo.
 */

import type { Request, Response } from "express";
import { getGrant } from "../lib/redis";
import { getRedis, KEYS } from "../lib/redis";

export async function handleStatus(req: Request, res: Response): Promise<void> {
  let repoId: string | undefined = Array.isArray(req.params["repoId"]) ? req.params["repoId"][0] : req.params["repoId"];

  if (!repoId && req.query["repo"]) {
    const repoFullName = String(req.query["repo"]);
    repoId = Buffer.from(repoFullName).toString("hex");
  }

  if (!repoId) {
    res.status(400).json({ ok: false, error: "repoId or ?repo=owner/repo required" });
    return;
  }

  const grant = await getGrant(repoId);
  if (!grant) {
    res.status(404).json({ ok: false, error: "No vesting grant found for this repo" });
    return;
  }

  const redis = getRedis();
  const pushLog = await redis.lrange(KEYS.pushLog(repoId), -20, -1);
  const recentPushes = pushLog.map((entry) => {
    try { return JSON.parse(entry); } catch { return entry; }
  });

  const totalMilestones = Math.floor(grant.totalPushesRequired / grant.pushesPerMilestone);
  const nextMilestoneAt = (grant.lastPaidMilestone + 1) * grant.pushesPerMilestone;
  const progressPct = grant.totalPushesRequired > 0
    ? Math.floor((grant.verifiedPushCount / grant.totalPushesRequired) * 100)
    : 0;

  res.json({
    ok: true,
    grant,
    progress: {
      verifiedPushCount: grant.verifiedPushCount,
      totalPushesRequired: grant.totalPushesRequired,
      progressPct,
      nextMilestoneAt: grant.verifiedPushCount >= grant.totalPushesRequired ? null : nextMilestoneAt,
      milestonesCompleted: grant.lastPaidMilestone,
      totalMilestones,
      pushesUntilNextRelease: Math.max(0, nextMilestoneAt - grant.verifiedPushCount),
    },
    recentPushes,
  });
}

/**
 * GET /api/vesting/list
 * List all vesting grants (admin / public dashboard).
 */
export async function handleList(req: Request, res: Response): Promise<void> {
  const { listAllGrants } = await import("../lib/redis");
  const grants = await listAllGrants();
  res.json({ ok: true, grants });
}
