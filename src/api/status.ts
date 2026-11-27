/**
 * GET /api/vesting/status/:repoId
 * GET /api/vesting/status?repo=owner/repo
 *
 * Returns the current vesting state for a repo.
 */

import type { Request, Response } from "express";
import {
  getGrant,
  getGrantById,
  getGrantByRepoFullName,
  listGrantsForRepo,
  getRedis,
  KEYS,
} from "../lib/redis";
import { buildGrantEntries, buildProgress, grantRelativeCount, repoPushTotal } from "../lib/grantsHelper";

export async function handleStatus(req: Request, res: Response): Promise<void> {
  let repoId: string | undefined = Array.isArray(req.params["repoId"])
    ? req.params["repoId"][0]
    : req.params["repoId"];

  if (!repoId && req.query["repo"]) {
    const grant = await getGrantByRepoFullName(String(req.query["repo"]));
    if (!grant) {
      res.status(404).json({ ok: false, error: "No vesting grant found for this repo" });
      return;
    }
    repoId = grant.repoId;
  }

  if (!repoId) {
    res.status(400).json({ ok: false, error: "repoId or ?repo=owner/repo required" });
    return;
  }

  // Multi-lock (§4.5): the top-level grant is the PRIMARY grant
  // (earliest-created active; else most recent) — for a repoId
  // param, resolve the repo's grants and pick it; the legacy record
  // is the fallback for repos with no grant list.
  const repoGrants = await listGrantsForRepo(repoId);
  const { pickPrimaryGrant } = await import("../lib/redis");
  const grant = pickPrimaryGrant(repoGrants) ?? (await getGrant(repoId));
  if (!grant) {
    res.status(404).json({ ok: false, error: "No vesting grant found for this repo" });
    return;
  }

  const redis = getRedis();
  const pushLog = await redis.lrange(KEYS.pushLog(repoId), -20, -1);
  const recentPushes = pushLog.map((entry) => {
    try { return JSON.parse(entry); } catch { return entry; }
  });

  const repoTotal = await repoPushTotal(repoId);
  const progress = buildProgress(grant, grantRelativeCount(grant, repoTotal));
  const grants = await buildGrantEntries(repoId, repoGrants);

  res.json({
    ok: true,
    grant,
    progress,
    grants,
    recentPushes,
  });
}

/**
 * GET /api/vesting/grant/:grantId
 * One V3 grant's full record + progress (design §4.5).
 */
export async function handleGrantById(req: Request, res: Response): Promise<void> {
  const grantId = String(req.params["grantId"] ?? "");
  const grant = await getGrantById(grantId);
  if (!grant) {
    res.status(404).json({ ok: false, error: "No vesting grant found for this grantId" });
    return;
  }
  const redis = getRedis();
  const pushLog = await redis.lrange(KEYS.pushLog(grant.repoId), -20, -1);
  const recentPushes = pushLog.map((entry) => {
    try { return JSON.parse(entry); } catch { return entry; }
  });
  const repoTotal = await repoPushTotal(grant.repoId);
  const entries = await buildGrantEntries(grant.repoId, [grant]);
  res.json({
    ok: true,
    grant,
    progress: buildProgress(grant, grantRelativeCount(grant, repoTotal)),
    ...(entries[0] ? { entry: entries[0] } : {}),
    recentPushes,
  });
}

/**
 * GET /api/vesting/list
 * List all vesting grants (admin / public dashboard).
 */
export async function handleList(_req: Request, res: Response): Promise<void> {
  const { listAllGrants } = await import("../lib/redis");
  const grants = await listAllGrants();
  res.json({ ok: true, grants });
}
