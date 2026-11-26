/**
 * Fee-lock oracle step (Gregory's decided launcher rule, 2026-11-25):
 * a launcher's trading fees must NOT arrive liquid — they accrue to
 * the project's FeeLockVault, a keeper locks them into FeeStreamEscrow
 * as tranches, and THIS step releases the vested part of those
 * tranches to the launcher's claim wallet when pushes count.
 *
 * It runs on the same webhook path and with the same oracle signer as
 * the supply release (triggerReleaseIfMilestone), immediately after
 * it, on EVERY counted push — fee tranches have their own schedule
 * (pushesPerTranche), independent of supply milestones. The contract
 * is no-op-safe: when nothing new has vested it pays nothing and does
 * not revert, and tranche vesting is computed from the counted-push
 * total on-chain, so a replayed webhook cannot double-release (the
 * verifier's atomic claim already prevents a replay from reaching
 * this code at all).
 *
 * FEE-RELEASE RETRY (Codex round-2, finding 4): the supply release
 * and the fee release are separate transactions. If the supply
 * release succeeded and the fee release then FAILS (tx error or an
 * on-chain revert — a reverted receipt is a failure, never a zero
 * payout), a durable pending-fee-release entry is recorded. It is
 * retried (a) implicitly on the next counted push — this function
 * runs again with the newer total, and releaseFee is cumulative and
 * idempotent on-chain, so the retry releases everything vested and
 * clears the entry — and (b) explicitly by the keeper sweep
 * (sweepPendingFeeReleases / scripts/fee-release-sweep.ts). The
 * supply release is never re-run by a fee retry: it has its own
 * milestone idempotency on-chain and this module never calls it.
 *
 * PARTIAL SETTLEMENT (Codex round-4, blocker 2): releaseFee is
 * work-capped on-chain (MAX_TRANCHES_PER_RELEASE), so a SUCCESSFUL
 * release transaction can still leave vested fees unpaid at the
 * target count. Settlement is therefore never inferred from the
 * receipt: after every successful release this module reads the
 * escrow's releasableAt(repoId, count) and clears the pending
 * entry ONLY when it reports zero due. While a remainder is due,
 * the entry stays (updated with the remaining amount) and the
 * sweep drains it with repeated releaseFee calls — no new pushes
 * required, so a launcher who stops shipping still receives every
 * vested wei.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../lib/env";
import { getVestingChainConfig, type VestingChainKey } from "../lib/chains";
import { getGrant, getRedis, KEYS, type GrantRecord } from "../lib/redis";
import { repoIdToBytes32 } from "../lib/repoId";
import { BUILDER_DATA_SUFFIX } from "../lib/builderCode";

const FEE_STREAM_ABI = parseAbi([
  "function releaseFee(bytes32 repoId, uint256 totalVerifiedPushes) external returns (uint256 paidNow)",
  "function releasableAt(bytes32 repoId, uint256 atPushCount) view returns (uint256)",
  "event FeeReleased(bytes32 indexed repoId, address indexed recipient, uint256 amount, uint256 totalVerifiedPushes, uint256 totalFeeReleasedSoFar)",
]);

export type FeeReleaseResult =
  | {
      triggered: true;
      txHash: string;
      payout: string;
      /** Vested-and-unpaid amount still due at the target count
       *  after this call (round-4): "0" means fully settled. */
      remainingDue: string;
    }
  | { triggered: false; reason: string };

export type PendingFeeRelease = {
  repoId: string;
  repoFullName: string;
  /** The counted-push total the failed release was attempted at. */
  pushCount: number;
  attempts: number;
  lastError: string;
  recordedAt: string;
  updatedAt: string;
};

async function recordPendingFeeRelease(
  repoId: string,
  grant: GrantRecord,
  pushCount: number,
  error: string,
): Promise<void> {
  try {
    const redis = getRedis();
    const existingRaw = await redis.get(KEYS.pendingFeeRelease(repoId));
    const existing = existingRaw ? (JSON.parse(existingRaw) as PendingFeeRelease) : null;
    const entry: PendingFeeRelease = {
      repoId,
      repoFullName: grant.repoFullName,
      pushCount,
      attempts: (existing?.attempts ?? 0) + 1,
      lastError: error.slice(0, 500),
      recordedAt: existing?.recordedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await redis.set(KEYS.pendingFeeRelease(repoId), JSON.stringify(entry));
    await redis.sadd(KEYS.pendingFeeReleaseIndex(), repoId);
  } catch (err) {
    console.error(`[fee-lock] Could not record pending fee release for ${grant.repoFullName}:`, err);
  }
}

async function clearPendingFeeRelease(repoId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(KEYS.pendingFeeRelease(repoId));
    await redis.srem(KEYS.pendingFeeReleaseIndex(), repoId);
  } catch { /* clearing is best-effort; a stale entry is retried harmlessly */ }
}

export async function getPendingFeeRelease(repoId: string): Promise<PendingFeeRelease | null> {
  const raw = await getRedis().get(KEYS.pendingFeeRelease(repoId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingFeeRelease;
  } catch {
    return null;
  }
}

export async function triggerFeeReleaseIfDue(
  repoId: string,
  grant: GrantRecord,
  newPushCount: number,
): Promise<FeeReleaseResult> {
  if (!grant.feeLockVault) {
    return { triggered: false, reason: "No fee-lock vault on this grant" };
  }
  const cfg = getVestingChainConfig(grant.chain as VestingChainKey);
  const escrowAddress = cfg.feeStreamEscrowAddress;
  if (!escrowAddress) {
    return { triggered: false, reason: `FeeStreamEscrow not configured for ${grant.chain}` };
  }

  try {
    const account = privateKeyToAccount(env.ORACLE_PRIVATE_KEY as `0x${string}`);
    const publicClient = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
    const walletClient = createWalletClient({
      account,
      chain: cfg.chain,
      transport: http(cfg.rpcUrl),
      dataSuffix: BUILDER_DATA_SUFFIX,
    });

    const hash = await walletClient.writeContract({
      address: escrowAddress as Address,
      abi: FEE_STREAM_ABI,
      functionName: "releaseFee",
      args: [repoIdToBytes32(repoId), BigInt(newPushCount)],
      account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      // A reverted release is a FAILURE (round-2): previously this
      // fell through to "payout 0 / nothing vested" and the fees were
      // silently stranded until a later push happened to retry.
      throw new Error(`releaseFee tx reverted on-chain (tx ${hash})`);
    }
    const events = parseEventLogs({ abi: FEE_STREAM_ABI, logs: receipt.logs, eventName: "FeeReleased" });
    const payout = events.reduce((acc, e) => acc + (e.args.amount ?? 0n), 0n);
    // Settlement check (round-4): releaseFee is work-capped, so a
    // successful tx may leave vested fees unpaid at this count.
    // Read what is still due; the pending entry is cleared ONLY at
    // zero due. While a remainder exists the entry stays queued —
    // the sweep drains it with repeat calls, no new push needed.
    const remainingDue = await publicClient.readContract({
      address: escrowAddress as Address,
      abi: FEE_STREAM_ABI,
      functionName: "releasableAt",
      args: [repoIdToBytes32(repoId), BigInt(newPushCount)],
    });
    if (remainingDue > 0n) {
      await recordPendingFeeRelease(
        repoId,
        grant,
        newPushCount,
        `release partially settled at count ${newPushCount}: ${remainingDue} wei still vested-and-unpaid (per-call tranche cap) — sweep will drain`,
      );
      console.log(
        `[fee-lock] Released ${payout} fee tokens to ${grant.recipient} for ${grant.repoFullName} (tx: ${hash}); ${remainingDue} wei still due at count ${newPushCount} — release stays queued`,
      );
      return {
        triggered: true,
        txHash: hash,
        payout: payout.toString(),
        remainingDue: remainingDue.toString(),
      };
    }
    await clearPendingFeeRelease(repoId);
    if (payout === 0n) {
      return { triggered: false, reason: `Push ${newPushCount}: no fee tranche vested yet` };
    }
    console.log(
      `[fee-lock] Released ${payout} fee tokens to ${grant.recipient} for ${grant.repoFullName} (tx: ${hash})`,
    );
    return { triggered: true, txHash: hash, payout: payout.toString(), remainingDue: "0" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[fee-lock] Fee release failed for ${grant.repoFullName}:`, msg);
    await recordPendingFeeRelease(repoId, grant, newPushCount, msg);
    return { triggered: false, reason: `Fee release tx failed: ${msg}` };
  }
}

/** Max releaseFee calls per repo per sweep run (round-4): each call
 *  settles up to MAX_TRANCHES_PER_RELEASE tranches on-chain, so 25
 *  calls drain a 400-tranche backlog; anything beyond that stays
 *  queued for the next sweep run — the entry persists until the
 *  contract reports zero due. */
export const MAX_SWEEP_CALLS_PER_REPO = 25;

/**
 * Keeper sweep: retry every durable pending fee release at the
 * repo's CURRENT counted total, looping until the escrow reports
 * zero vested-and-unpaid at that count (round-4: a work-capped
 * release can need several calls; the sweep supplies them with NO
 * new pushes). Each fully-settled repo's entry is cleared by the
 * release path itself; failures and partial remainders stay
 * pending with an incremented attempt counter. Supply releases are
 * never touched here.
 */
export async function sweepPendingFeeReleases(): Promise<
  Array<{ repoId: string; repoFullName: string; result: FeeReleaseResult }>
> {
  const redis = getRedis();
  const repoIds = await redis.smembers(KEYS.pendingFeeReleaseIndex());
  const out: Array<{ repoId: string; repoFullName: string; result: FeeReleaseResult }> = [];
  for (const repoId of repoIds) {
    const pending = await getPendingFeeRelease(repoId);
    if (!pending) {
      await redis.srem(KEYS.pendingFeeReleaseIndex(), repoId);
      continue;
    }
    const grant = await getGrant(repoId);
    if (!grant) {
      out.push({
        repoId,
        repoFullName: pending.repoFullName,
        result: { triggered: false, reason: "Grant no longer exists — pending entry left for manual review" },
      });
      continue;
    }
    const liveCount = parseInt((await redis.get(KEYS.pushCount(repoId))) ?? "0", 10);
    const targetCount = Math.max(liveCount, pending.pushCount);
    let result = await triggerFeeReleaseIfDue(repoId, grant, targetCount);
    // Drain loop: while the last call landed and the contract still
    // reports vested-and-unpaid at the target count, call again.
    for (
      let calls = 1;
      calls < MAX_SWEEP_CALLS_PER_REPO &&
      result.triggered &&
      result.remainingDue !== "0";
      calls++
    ) {
      result = await triggerFeeReleaseIfDue(repoId, grant, targetCount);
    }
    out.push({ repoId, repoFullName: grant.repoFullName, result });
  }
  return out;
}
