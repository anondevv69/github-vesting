/**
 * POST /api/admin/delete-grant
 * Body: { repoFullName: "owner/repo", platform?: "github" | "gitlawb" }
 * Header: x-admin-secret — must match ADMIN_SECRET env
 */

import type { Request, Response } from "express";
import { deleteGrantByRepoFullName } from "../lib/redis";
import { env } from "../lib/env";
import type { RepoPlatform } from "../lib/repoId";

export async function handleAdminDeleteGrant(req: Request, res: Response): Promise<void> {
  const secret = env.ADMIN_SECRET.trim();
  if (!secret) {
    res.status(503).json({ ok: false, error: "ADMIN_SECRET not configured" });
    return;
  }

  const provided = String(req.headers["x-admin-secret"] ?? "").trim();
  if (provided !== secret) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const body = req.body as { repoFullName?: string; platform?: RepoPlatform };
  const repoFullName = String(body.repoFullName ?? "").trim();
  if (!repoFullName.includes("/")) {
    res.status(400).json({ ok: false, error: "repoFullName required (owner/repo)" });
    return;
  }

  const platform = body.platform === "gitlawb" ? "gitlawb" : "github";
  const deleted = await deleteGrantByRepoFullName(repoFullName, platform);
  if (!deleted) {
    res.status(404).json({ ok: false, error: "Grant not found" });
    return;
  }

  res.json({
    ok: true,
    deleted: {
      repoFullName: deleted.repoFullName,
      repoId: deleted.repoId,
      chain: deleted.chain,
      onChainTxHash: deleted.onChainTxHash,
    },
  });
}
