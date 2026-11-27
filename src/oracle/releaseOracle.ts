/**
 * Oracle: when a new milestone is hit, call GitEscrow.release() on Base.
 * For legacy streaming grants on old contracts, forwards tokens to the
 * recipient after release() in a follow-up tx (with retries).
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../lib/env";
import {
  escrowVersionOf,
  getVestingChainConfig,
  resolveGrantEscrowAddress,
  type VestingChainKey,
} from "../lib/chains";
import { parseWei } from "../lib/wei";
import { updateGrant, updateGrantById, type GrantRecord } from "../lib/redis";
import { repoIdToBytes32 } from "../lib/repoId";
import { BUILDER_DATA_SUFFIX } from "../lib/builderCode";

const GIT_ESCROW_ABI = parseAbi([
  "function release(bytes32 repoId, uint256 totalVerifiedPushes) external",
  "function grants(bytes32) view returns (address recipient, address token, uint256 totalLocked, uint256 totalReleased, uint256 totalPushesRequired, uint256 pushesPerMilestone, uint256 tokensPerMilestone, uint256 lastPaidMilestone, bool active, bool streaming, uint64 lockedAt)",
  "event Released(bytes32 indexed repoId, address indexed recipient, uint256 amount, uint256 pushMilestone, uint256 totalReleasedSoFar)",
]);

const GIT_ESCROW_V3_ABI = parseAbi([
  "function release(bytes32 grantId, uint256 totalVerifiedPushes) external",
  "function reportCount(bytes32 repoId, uint256 totalVerifiedPushes) external",
  "event Released(bytes32 indexed grantId, bytes32 indexed repoId, address indexed recipient, uint256 amount, uint256 pushMilestone, uint256 totalReleasedSoFar)",
]);

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

export type ReleaseResult =
  | { triggered: true; txHash: string; forwardTxHash?: string; milestone: number; payout: string }
  | { triggered: false; reason: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClients(chain: GrantRecord["chain"]) {
  const account = privateKeyToAccount(env.ORACLE_PRIVATE_KEY as `0x${string}`);
  const cfg = getVestingChainConfig(chain as VestingChainKey);

  const publicClient = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain: cfg.chain,
    transport: http(cfg.rpcUrl),
    dataSuffix: BUILDER_DATA_SUFFIX,
  });
  return { publicClient, walletClient, account, cfg };
}

function payoutFromReleaseReceipt(
  receipt: Awaited<ReturnType<ReturnType<typeof createPublicClient>["waitForTransactionReceipt"]>>,
  fallback: bigint,
): bigint {
  const events = parseEventLogs({
    abi: GIT_ESCROW_ABI,
    logs: receipt.logs,
    eventName: "Released",
  });
  const amount = events[0]?.args.amount;
  return amount && amount > 0n ? amount : fallback;
}

function payoutFromV3ReleaseReceipt(
  receipt: Awaited<ReturnType<ReturnType<typeof createPublicClient>["waitForTransactionReceipt"]>>,
  escrowAddress: string,
  fallback: bigint,
): bigint {
  const events = parseEventLogs({
    abi: GIT_ESCROW_V3_ABI,
    logs: receipt.logs.filter(
      (l) => l.address.toLowerCase() === escrowAddress.toLowerCase(),
    ),
    eventName: "Released",
  });
  const amount = events[0]?.args.amount;
  return amount && amount > 0n ? amount : fallback;
}

/** True when this grant lives in GitEscrowV3 (design §4.4 branch). */
export function isV3Grant(grant: GrantRecord): boolean {
  if (grant.escrowVersion) return grant.escrowVersion === 3;
  if (!grant.grantId) return false;
  return escrowVersionOf(grant.chain as VestingChainKey, grant.escrowAddress) === 3;
}

/**
 * §2.3 reportCount obligation: advance GitEscrowV3's known repo
 * counted total when no V3 release in this pass already carried it.
 * Best-effort by design (the caller logs failures): a missed report
 * only widens the bounded baseline window the design accepts, and
 * the next counted push re-reports.
 */
export async function reportRepoCountToV3(
  grant: GrantRecord,
  repoTotal: number,
): Promise<{ reported: boolean; txHash?: string; reason?: string }> {
  const escrowAddress = resolveGrantEscrowAddress(grant);
  if (!escrowAddress) return { reported: false, reason: "no escrow resolved" };
  try {
    const { publicClient, walletClient, account } = getClients(grant.chain);
    const code = await publicClient.getCode({ address: escrowAddress as Address });
    if (!code || code === "0x") {
      return { reported: false, reason: `escrow ${escrowAddress} has no code` };
    }
    const hash = await walletClient.writeContract({
      address: escrowAddress as Address,
      abi: GIT_ESCROW_V3_ABI,
      functionName: "reportCount",
      args: [repoIdToBytes32(grant.repoId), BigInt(repoTotal)],
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[oracle] reportCount(${grant.repoFullName}, ${repoTotal}) → V3 escrow (tx: ${hash})`);
    return { reported: true, txHash: hash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[oracle] reportCount failed for ${grant.repoFullName}: ${msg}`);
    return { reported: false, reason: msg };
  }
}

/** Forward tokens sitting on the oracle wallet → grant recipient (legacy streaming). */
export async function forwardStreamingPayoutToRecipient(
  grant: GrantRecord,
  payout: bigint,
): Promise<Hash> {
  const { publicClient, walletClient, account } = getClients(grant.chain);
  const token = grant.token as Address;
  const recipient = grant.recipient as Address;

  const oracleBalance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  if (oracleBalance === 0n) {
    throw new Error(`Oracle has no ${token} balance to forward`);
  }

  // Forward the released amount, or the full oracle balance if that's all we hold.
  const amount = oracleBalance >= payout ? payout : oracleBalance;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const fwdHash = await walletClient.writeContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [recipient, amount],
        account,
      });
      await publicClient.waitForTransactionReceipt({ hash: fwdHash });
      console.log(`[oracle] Forwarded ${amount} ${token} → ${recipient} (tx: ${fwdHash})`);
      return fwdHash;
    } catch (err) {
      lastErr = err;
      console.warn(`[oracle] Forward attempt ${attempt}/3 failed:`, err);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Recover tokens stuck on the oracle from a prior release that never forwarded. */
export async function recoverStuckStreamingTokens(
  grant: Pick<GrantRecord, "token" | "recipient" | "chain">,
): Promise<{ forwarded: boolean; txHash?: Hash; amount: string }> {
  const { publicClient, account } = getClients(grant.chain);
  const balance = await publicClient.readContract({
    address: grant.token as Address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  if (balance === 0n) {
    return { forwarded: false, amount: "0" };
  }

  const txHash = await forwardStreamingPayoutToRecipient(
    { ...grant, tokensPerMilestone: balance.toString() } as GrantRecord,
    balance,
  );
  return { forwarded: true, txHash, amount: balance.toString() };
}

export async function triggerReleaseIfMilestone(
  repoId: string,
  grant: GrantRecord,
  newPushCount: number,
): Promise<ReleaseResult> {
  // ── V3 basis (design §4.4): `newPushCount` is the repo CUMULATIVE
  // total; the grant's milestones derive from its on-chain baseline.
  if (isV3Grant(grant)) {
    return triggerReleaseV3(repoId, grant, newPushCount);
  }
  const currentMilestone = Math.floor(newPushCount / grant.pushesPerMilestone);
  const maxMilestone = Math.floor(grant.totalPushesRequired / grant.pushesPerMilestone);
  const clampedMilestone = Math.min(currentMilestone, maxMilestone);

  if (clampedMilestone <= grant.lastPaidMilestone) {
    return {
      triggered: false,
      reason: `Push ${newPushCount}: next milestone at ${(grant.lastPaidMilestone + 1) * grant.pushesPerMilestone} pushes`,
    };
  }

  // Per-grant escrow (v1→v2 cutover): a grant is released from the
  // escrow it was created under — its recorded escrow, or the chain's
  // legacy escrow for pre-cutover grants — never from whichever
  // escrow the chain config was since repointed to.
  const escrowAddress = resolveGrantEscrowAddress(grant);
  if (!escrowAddress) {
    return { triggered: false, reason: `GitEscrow not configured for ${grant.chain}` };
  }

  console.log(
    `[oracle] Milestone ${clampedMilestone} reached for ${grant.repoFullName} — triggering release`,
  );

  try {
    const { publicClient, walletClient, account } = getClients(grant.chain);

    // Fail loudly, never vacuously: a release call to an address
    // with no contract code "succeeds" on-chain while paying nothing
    // and would still mark the milestone paid. A misresolved escrow
    // (bad cutover config) must surface as a failed release instead.
    const escrowCode = await publicClient.getCode({ address: escrowAddress as Address });
    if (!escrowCode || escrowCode === "0x") {
      return {
        triggered: false,
        reason: `Resolved escrow ${escrowAddress} has no contract code on ${grant.chain} — refusing to release`,
      };
    }

    const repoIdBytes32 = repoIdToBytes32(repoId);

    const expectedPayout =
      parseWei(grant.tokensPerMilestone) * BigInt(clampedMilestone - grant.lastPaidMilestone);

    const oracleBalBefore = grant.streaming
      ? await publicClient.readContract({
          address: grant.token as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        })
      : 0n;

    const hash = await walletClient.writeContract({
      address: escrowAddress as Address,
      abi: GIT_ESCROW_ABI,
      functionName: "release",
      args: [repoIdBytes32, BigInt(newPushCount)],
      account,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[oracle] Release tx confirmed: ${hash} (milestone ${clampedMilestone})`);

    const payout = payoutFromReleaseReceipt(receipt, expectedPayout);
    let forwardTxHash: Hash | undefined;

    // Legacy deployed contract: release() leaves tokens on oracle — forward now.
    // New contract: release() forwards atomically; oracle balance unchanged.
    if (grant.streaming) {
      const oracleBalAfter = await publicClient.readContract({
        address: grant.token as Address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      const received = oracleBalAfter - oracleBalBefore;

      if (received > 0n) {
        console.log(
          `[oracle] Legacy streaming release — forwarding ${received} to ${grant.recipient}`,
        );
        forwardTxHash = await forwardStreamingPayoutToRecipient(grant, payout);
      } else {
        console.log(`[oracle] Streaming payout delivered in release tx (atomic forward)`);
      }
    }

    const isFinal = clampedMilestone >= maxMilestone;
    await updateGrant(repoId, {
      lastPaidMilestone: clampedMilestone,
      status: isFinal ? "complete" : "active",
    });

    return {
      triggered: true,
      txHash: hash,
      forwardTxHash,
      milestone: clampedMilestone,
      payout: payout.toString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[oracle] Release failed for ${grant.repoFullName}:`, msg);
    return { triggered: false, reason: `Oracle tx failed: ${msg}` };
  }
}

/**
 * V3 release path (design §4.4): milestones =
 * clamp(floor((repoTotal − startPushCount) / pushesPerMilestone));
 * the contract call is release(grantId, repoTotal) on the grant's
 * V3 escrow, and bookkeeping lands on the grant_by_id record.
 */
async function triggerReleaseV3(
  repoId: string,
  grant: GrantRecord,
  repoTotal: number,
): Promise<ReleaseResult> {
  const start = grant.startPushCount ?? 0;
  const elapsed = Math.max(0, repoTotal - start);
  const currentMilestone = Math.floor(elapsed / grant.pushesPerMilestone);
  const maxMilestone = Math.floor(grant.totalPushesRequired / grant.pushesPerMilestone);
  const clampedMilestone = Math.min(currentMilestone, maxMilestone);

  if (clampedMilestone <= grant.lastPaidMilestone) {
    return {
      triggered: false,
      reason: `Push ${repoTotal} (grant elapsed ${elapsed}): next milestone at repo total ${start + (grant.lastPaidMilestone + 1) * grant.pushesPerMilestone}`,
    };
  }
  if (!grant.grantId) {
    return { triggered: false, reason: "V3 grant record is missing its grantId" };
  }

  const escrowAddress = resolveGrantEscrowAddress(grant);
  if (!escrowAddress) {
    return { triggered: false, reason: `GitEscrow not configured for ${grant.chain}` };
  }

  console.log(
    `[oracle] V3 milestone ${clampedMilestone} reached for ${grant.repoFullName} grant ${grant.grantId} — triggering release`,
  );

  try {
    const { publicClient, walletClient, account } = getClients(grant.chain);

    const escrowCode = await publicClient.getCode({ address: escrowAddress as Address });
    if (!escrowCode || escrowCode === "0x") {
      return {
        triggered: false,
        reason: `Resolved escrow ${escrowAddress} has no contract code on ${grant.chain} — refusing to release`,
      };
    }

    const expectedPayout =
      parseWei(grant.tokensPerMilestone) * BigInt(clampedMilestone - grant.lastPaidMilestone);

    const oracleBalBefore = grant.streaming
      ? await publicClient.readContract({
          address: grant.token as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        })
      : 0n;

    const hash = await walletClient.writeContract({
      address: escrowAddress as Address,
      abi: GIT_ESCROW_V3_ABI,
      functionName: "release",
      args: [grant.grantId as `0x${string}`, BigInt(repoTotal)],
      account,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[oracle] V3 release tx confirmed: ${hash} (milestone ${clampedMilestone})`);

    const payout = payoutFromV3ReleaseReceipt(receipt, escrowAddress, expectedPayout);
    let forwardTxHash: Hash | undefined;

    if (grant.streaming) {
      const oracleBalAfter = await publicClient.readContract({
        address: grant.token as Address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      const received = oracleBalAfter - oracleBalBefore;
      if (received > 0n) {
        forwardTxHash = await forwardStreamingPayoutToRecipient(grant, payout);
      }
    }

    const isFinal = clampedMilestone >= maxMilestone;
    await updateGrantById(grant.grantId, {
      lastPaidMilestone: clampedMilestone,
      status: isFinal ? "complete" : "active",
    });

    return {
      triggered: true,
      txHash: hash,
      forwardTxHash,
      milestone: clampedMilestone,
      payout: payout.toString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[oracle] V3 release failed for ${grant.repoFullName}:`, msg);
    return { triggered: false, reason: `Oracle tx failed: ${msg}` };
  }
}
