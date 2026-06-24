/**
 * Developer public profile (bio, links) — editable by verified wallet owner.
 */

import type { Request, Response } from "express";
import { listAllGrants, getRedis, KEYS } from "../lib/redis";
import { isValidWallet } from "../lib/grantsHelper";
import { splitRepo } from "../lib/repoId";

export type DevProfileLink = { label: string; url: string };

export type DevProfile = {
  githubLogin: string;
  displayName?: string;
  bio?: string;
  twitter?: string;
  website?: string;
  links?: DevProfileLink[];
  updatedAt?: string;
};

function profileKey(login: string): string {
  return KEYS.devProfile(login);
}

export async function getDevProfile(login: string): Promise<DevProfile | null> {
  const raw = await getRedis().get(profileKey(login));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DevProfile;
  } catch {
    return null;
  }
}

async function canEditProfile(login: string, wallet: string): Promise<boolean> {
  const grants = (await listAllGrants()).filter((g) => {
    const [owner] = splitRepo(g.repoFullName, g.platform ?? "github");
    return owner.toLowerCase() === login.toLowerCase();
  });
  return grants.some((g) => g.recipient.toLowerCase() === wallet.toLowerCase());
}

export async function handleGetDevProfile(req: Request, res: Response): Promise<void> {
  const login = String(req.params["login"] ?? "").trim().toLowerCase();
  if (!login) {
    res.status(400).json({ ok: false, error: "login required" });
    return;
  }

  const profile = (await getDevProfile(login)) ?? { githubLogin: login };
  const wallet = String(req.query["wallet"] ?? req.headers["x-wallet-address"] ?? "").trim().toLowerCase();
  const editable = wallet && isValidWallet(wallet)
    ? await canEditProfile(login, wallet)
    : false;

  res.json({ ok: true, profile: { ...profile, githubLogin: login }, editable });
}

export async function handlePatchDevProfile(req: Request, res: Response): Promise<void> {
  const login = String(req.params["login"] ?? "").trim().toLowerCase();
  const wallet = String(req.body?.wallet ?? req.headers["x-wallet-address"] ?? "").trim().toLowerCase();

  if (!login) {
    res.status(400).json({ ok: false, error: "login required" });
    return;
  }
  if (!isValidWallet(wallet)) {
    res.status(403).json({ ok: false, error: "wallet required to edit profile" });
    return;
  }
  if (!(await canEditProfile(login, wallet))) {
    res.status(403).json({ ok: false, error: "wallet does not own a lock for this GitHub account" });
    return;
  }

  const bio = String(req.body?.bio ?? "").trim().slice(0, 160);
  const twitter = String(req.body?.twitter ?? "").trim().replace(/^@/, "").slice(0, 32);
  const website = String(req.body?.website ?? "").trim().slice(0, 200);
  const displayName = String(req.body?.displayName ?? "").trim().slice(0, 64);

  let links: DevProfileLink[] = [];
  if (Array.isArray(req.body?.links)) {
    links = req.body.links
      .slice(0, 4)
      .map((l: { label?: string; url?: string }) => ({
        label: String(l.label ?? "").trim().slice(0, 32),
        url: String(l.url ?? "").trim().slice(0, 200),
      }))
      .filter((l: DevProfileLink) => l.url.length > 0);
  }

  const profile: DevProfile = {
    githubLogin: login,
    displayName: displayName || undefined,
    bio: bio || undefined,
    twitter: twitter || undefined,
    website: website || undefined,
    links: links.length ? links : undefined,
    updatedAt: new Date().toISOString(),
  };

  await getRedis().set(profileKey(login), JSON.stringify(profile));

  res.json({ ok: true, profile });
}
