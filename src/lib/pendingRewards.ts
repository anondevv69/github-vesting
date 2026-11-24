/**
 * Pending merge rewards (spec §8B, audit H2): when a counted merge's author
 * has NO linked wallet, the per-merge reward is not lost — it is recorded
 * here, keyed by (login, merge SHA), at the amount configured at earn time.
 * When the author later links a wallet (any link flow — they all funnel
 * through `addLinkedWallet`), the oracle settles every pending entry to the
 * newly linked wallet via `ShipRewards.pay()` (see
 * `settlePendingRewardsForLogin` in oracle/shipRewards.ts).
 *
 * Storage mirrors the linked-wallet store: one JSON list per login in
 * Redis. Idempotency is two-layered: recording dedupes on merge SHA, and
 * the on-chain `ShipRewards.paid[mergeCommitHash]` flag remains the final
 * settlement guard — a pending entry can never pay a merge twice.
 */

import { getRedis, KEYS } from "./redis";

export type PendingReward = {
  /** GitHub login (lowercase) that earned the reward. */
  login: string;
  /** Repo the merge landed on — repoId hex (no 0x) and full name. */
  repoId: string;
  repoFullName: string;
  /** Merge commit SHA (lowercase) — the on-chain payment key. */
  mergeSha: string;
  /** Reward amount in token wei, captured at earn time. */
  amount: string;
  /** Chain the reward pool lives on ("base" | "robinhood" | …). */
  chain: string;
  /** ISO timestamp of when the merge was counted. */
  earnedAt: string;
};

function pendingKey(login: string): string {
  return KEYS.devPendingRewards(login);
}

export async function listPendingRewards(login: string): Promise<PendingReward[]> {
  const raw = await getRedis().get(pendingKey(login.toLowerCase()));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as PendingReward[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function savePendingRewards(login: string, list: PendingReward[]): Promise<void> {
  const key = pendingKey(login.toLowerCase());
  if (list.length === 0) {
    await getRedis().del(key);
    return;
  }
  await getRedis().set(key, JSON.stringify(list));
}

/**
 * Record an earned-but-unpayable reward. Idempotent per merge SHA: returns
 * false (and changes nothing) when an entry for this merge already exists
 * for the login — webhook redeliveries can never double-accrue.
 */
export async function recordPendingReward(entry: PendingReward): Promise<boolean> {
  const login = entry.login.toLowerCase();
  const mergeSha = entry.mergeSha.toLowerCase();
  const list = await listPendingRewards(login);
  if (list.some((p) => p.mergeSha === mergeSha)) return false;
  list.push({ ...entry, login, mergeSha });
  await savePendingRewards(login, list);
  console.log(
    `[ship-rewards] Accrued pending reward of ${entry.amount} wei for @${login} ` +
      `(merge ${mergeSha.slice(0, 7)} on ${entry.repoFullName}, chain ${entry.chain})`,
  );
  return true;
}

/** Drop one pending entry (after it settles or is found already paid on-chain). */
export async function removePendingReward(login: string, mergeSha: string): Promise<void> {
  const key = login.toLowerCase();
  const sha = mergeSha.toLowerCase();
  const list = await listPendingRewards(key);
  const next = list.filter((p) => p.mergeSha !== sha);
  if (next.length !== list.length) await savePendingRewards(key, next);
}

/** Sum of pending amounts (wei) for a login; unparseable entries count as 0. */
export function pendingRewardsTotal(list: PendingReward[]): string {
  let total = 0n;
  for (const p of list) {
    try {
      total += BigInt(p.amount);
    } catch {
      /* skip malformed amounts */
    }
  }
  return total.toString();
}
