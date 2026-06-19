/**
 * Oracle: when a new milestone is hit, call GitEscrow.release() on Base.
 */

import { createWalletClient, createPublicClient, http, parseAbi, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../lib/env";
import { updateGrant, type GrantRecord } from "../lib/redis";

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
  | { triggered: true; txHash: string; milestone: number; payout: string }
  | { triggered: false; reason: string };

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
    const repoIdBytes32 = `0x${Buffer.from(repoId, "hex").toString("hex").padEnd(64, "0")}` as `0x${string}`;

    const hash = await walletClient.writeContract({
      address: env.GIT_ESCROW_ADDRESS as Address,
      abi: GIT_ESCROW_ABI,
      functionName: "release",
      args: [repoIdBytes32, BigInt(newPushCount)],
      account,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[oracle] Release tx confirmed: ${hash} (milestone ${clampedMilestone})`);

    // For streaming-allowance grants, the contract pulls tokens into the
    // oracle's wallet. Forward them to the recipient in a follow-up tx.
    if (grant.streaming) {
      const payout = BigInt(grant.tokensPerMilestone) *
        BigInt(clampedMilestone - grant.lastPaidMilestone);
      const bal = await publicClient.readContract({
        address: grant.token as Address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      if (bal >= payout) {
        const fwdHash = await walletClient.writeContract({
          address: grant.token as Address,
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [grant.recipient as Address, payout],
          account,
        });
        await publicClient.waitForTransactionReceipt({ hash: fwdHash });
        console.log(`[oracle] Forwarded ${payout} to ${grant.recipient} (tx: ${fwdHash})`);
      } else {
        console.warn(
          `[oracle] Insufficient oracle balance to forward: have ${bal}, need ${payout}. ` +
          `Recipient will need to claim manually.`,
        );
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
      milestone: clampedMilestone,
      payout: grant.tokensPerMilestone,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[oracle] Release failed for ${grant.repoFullName}:`, msg);
    return { triggered: false, reason: `Oracle tx failed: ${msg}` };
  }
}
