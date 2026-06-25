/**
 * Link EVM wallets to a GitHub dev identity (incl. Bankr fee-recipient wallets).
 */

import { randomBytes } from "crypto";
import type { Address, Hex } from "viem";
import { getRedis, KEYS } from "./redis";
import { isValidWallet } from "./grantsHelper";
import { verifyWalletMessage } from "./walletSignature";

const LINK_CHALLENGE_TTL_SEC = 60 * 15;

export type LinkedWallet = {
  wallet: string;
  linkedAt: string;
  source: "signed" | "repo-claim" | "lock" | "bankr";
};

export type PendingWalletLink = {
  githubLogin: string;
  wallet: string;
  signMessage: string;
  expiresAt: string;
  createdAt: string;
};

function linkKey(login: string): string {
  return KEYS.devLinkedWallets(login);
}

export function buildWalletLinkMessage(githubLogin: string, wallet: string): string {
  return (
    `Proof of Dev — link wallet to GitHub\n` +
    `GitHub: ${githubLogin}\n` +
    `Wallet: ${wallet.toLowerCase()}`
  );
}

export async function listLinkedWallets(githubLogin: string): Promise<LinkedWallet[]> {
  const raw = await getRedis().get(linkKey(githubLogin.toLowerCase()));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as LinkedWallet[];
    return list.filter((w) => isValidWallet(w.wallet));
  } catch {
    return [];
  }
}

export async function isWalletLinked(githubLogin: string, wallet: string): Promise<boolean> {
  const list = await listLinkedWallets(githubLogin);
  return list.some((w) => w.wallet === wallet.toLowerCase());
}

export async function addLinkedWallet(
  githubLogin: string,
  wallet: string,
  source: LinkedWallet["source"] = "signed",
): Promise<LinkedWallet[]> {
  if (!isValidWallet(wallet)) return listLinkedWallets(githubLogin);
  const login = githubLogin.toLowerCase();
  const addr = wallet.toLowerCase();
  const list = await listLinkedWallets(login);
  if (list.some((w) => w.wallet === addr)) return list;

  const next: LinkedWallet[] = [
    ...list,
    { wallet: addr, linkedAt: new Date().toISOString(), source },
  ].sort((a, b) => b.linkedAt.localeCompare(a.linkedAt));

  await getRedis().set(linkKey(login), JSON.stringify(next));
  return next;
}

export async function createWalletLinkChallenge(
  githubLogin: string,
  wallet: string,
): Promise<{ signMessage: string; githubLogin: string; wallet: string }> {
  if (!isValidWallet(wallet)) throw new Error("Invalid wallet address");
  const login = githubLogin.toLowerCase();
  const addr = wallet.toLowerCase();
  const challengeId = randomBytes(16).toString("hex");
  const baseMessage = buildWalletLinkMessage(login, addr);
  const signMessage = `${baseMessage}\nNonce: ${challengeId}`;
  const now = new Date();
  const pending: PendingWalletLink = {
    githubLogin: login,
    wallet: addr,
    signMessage: baseMessage,
    expiresAt: new Date(now.getTime() + LINK_CHALLENGE_TTL_SEC * 1000).toISOString(),
    createdAt: now.toISOString(),
  };
  await getRedis().set(
    KEYS.devWalletLinkChallenge(challengeId),
    JSON.stringify(pending),
    "EX",
    LINK_CHALLENGE_TTL_SEC,
  );
  return { signMessage, githubLogin: login, wallet: addr };
}

export async function confirmWalletLink(
  githubLogin: string,
  wallet: string,
  signature: string,
  signMessage: string,
): Promise<LinkedWallet[]> {
  const login = githubLogin.toLowerCase();
  const addr = wallet.toLowerCase();
  if (!isValidWallet(addr)) throw new Error("Invalid wallet");

  const nonceMatch = signMessage.match(/Nonce: ([a-f0-9]+)$/i);
  if (!nonceMatch) throw new Error("Invalid sign message");
  const challengeId = nonceMatch[1]!;
  const raw = await getRedis().get(KEYS.devWalletLinkChallenge(challengeId));
  if (!raw) throw new Error("Link challenge expired — try again");

  const pending = JSON.parse(raw) as PendingWalletLink;
  if (pending.githubLogin !== login || pending.wallet !== addr) {
    throw new Error("Challenge does not match GitHub login or wallet");
  }

  const expected = buildWalletLinkMessage(login, addr) + `\nNonce: ${challengeId}`;
  if (signMessage.trim() !== expected.trim()) {
    throw new Error("Sign message mismatch");
  }

  const valid = await verifyWalletMessage(
    addr as Address,
    signMessage,
    signature as Hex,
  );
  if (!valid) throw new Error("Invalid wallet signature");

  await getRedis().del(KEYS.devWalletLinkChallenge(challengeId));
  return addLinkedWallet(login, addr, "signed");
}
