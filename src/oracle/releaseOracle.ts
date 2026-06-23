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
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../lib/env";
import { updateGrant, type GrantRecord } from "../lib/redis";
import { repoIdToBytes32 } from "../lib/repoId";

const GIT_ESCROW_ABI = parseAbi([
  "function release(bytes32 repoId, uint256 totalVerifiedPushes) external",
  "function grants(bytes32) view returns (address recipient, address token, uint256 totalLocked, uint256 totalReleased, uint256 totalPushesRequired, uint256 pushesPerMilestone, uint256 tokensPerMilestone, uint256 lastPaidMilestone, bool active, bool streaming, uint64 lockedAt)",
  "event Released(bytes32 indexed repoId, address indexed recipient, uint256 amount, uint256 pushMilestone, uint256 totalReleasedSoFar)",
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
  const rpcUrl = chain === "base" ? env.BASE_RPC_URL : env.BASE_SEPOLIA_RPC_URL;
  const viemChain = chain === "base" ? base : baseSepolia;

  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain: viemChain,
    transport: http(rpcUrl),
  });
  return { publicClient, walletClient, account };
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
  const currentMilestone = Math.floor(newPushCount / grant.pushesPerMilestone);
  const maxMilestone = Math.floor(grant.totalPushesRequired / grant.pushesPerMilestone);
  const clampedMilestone = Math.min(currentMilestone, maxMilestone);

  if (clampedMilestone <= grant.lastPaidMilestone) {
    return {
      triggered: false,
      reason: `Push ${newPushCount}: next milestone at ${(grant.lastPaidMilestone + 1) * grant.pushesPerMilestone} pushes`,
    };
  }

  if (!env.GIT_ESCROW_ADDRESS) {
    return { triggered: false, reason: "GIT_ESCROW_ADDRESS not configured" };
  }

  console.log(
    `[oracle] Milestone ${clampedMilestone} reached for ${grant.repoFullName} — triggering release`,
  );

  try {
    const { publicClient, walletClient, account } = getClients(grant.chain);
    const repoIdBytes32 = repoIdToBytes32(repoId);

    const expectedPayout =
      BigInt(grant.tokensPerMilestone) * BigInt(clampedMilestone - grant.lastPaidMilestone);

    const oracleBalBefore = grant.streaming
      ? await publicClient.readContract({
          address: grant.token as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        })
      : 0n;

    const hash = await walletClient.writeContract({
      address: env.GIT_ESCROW_ADDRESS as Address,
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
