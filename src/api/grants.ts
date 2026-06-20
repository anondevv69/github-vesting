/**
 * GET /api/vesting/grants?recipient=0x...
 * Returns active/completed grants for a wallet address.
 */

import type { Request, Response } from "express";
import { fetchGrantsForRecipient, isValidWallet } from "../lib/grantsHelper";

export async function handleGrantsByRecipient(req: Request, res: Response): Promise<void> {
  const recipient = String(req.query["recipient"] ?? "").toLowerCase();
  if (!recipient || !isValidWallet(recipient)) {
    res.status(400).json({ ok: false, error: "recipient query param required (0x address)" });
    return;
  }

  const enriched = await fetchGrantsForRecipient(recipient);
  res.json({ ok: true, grants: enriched });
}
