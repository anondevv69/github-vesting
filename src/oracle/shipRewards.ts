/**
 * Ship reward oracle (spec §8B): on every COUNTED merged PR, pay the flat
 * per-merge reward from the pre-funded ShipRewards pool to the PR author's
 * linked wallet.
 *
 * Safety rails:
 *  - No-ops (paid: false, with a reason) when SHIP_REWARDS_ADDRESS is unset,
 *    when SHIP_REWARD_PER_MERGE is unset/0/unparseable, or when the author
 *    has no linked wallet (reward stays pending until they link one — it is
 *    never sent to a guessed address).
 *  - On-chain idempotency: ShipRewards.paid[mergeCommitHash] is checked
 *    before sending, and the contract itself refuses a second payment.
 *  - Never throws into the push pipeline — failures are logged and returned.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../lib/env";
import { getVestingChainConfig, type VestingChainKey } from "../lib/chains";
import { parseWei } from "../lib/wei";
import { repoIdToBytes32 } from "../lib/repoId";
import { listLinkedWallets } from "../lib/devWallets";
import type { GrantRecord } from "../lib/redis";

const SHIP_REWARDS_ABI = parseAbi([
  "function pay(bytes32 repoId, address recipient, uint256 amount, bytes32 mergeCommitHash) external",
  "function isPaid(bytes32 mergeCommitHash) view returns (bool)",
  "event Paid(bytes32 indexed repoId, address indexed recipient, uint256 amount, bytes32 indexed mergeCommitHash)",
]);

export type RewardResult =
  | { paid: true; txHash: string; recipient: string; amount: string }
  | { paid: false; reason: string };

/** Configured per-merge reward in token wei; 0n when disabled/unset/invalid. */
export function configuredRewardPerMerge(): bigint {
  const raw = (env.SHIP_REWARD_PER_MERGE ?? "").trim();
  if (!raw) return 0n;
  try {
    return parseWei(raw);
  } catch {
    console.warn(`[ship-rewards] SHIP_REWARD_PER_MERGE="${raw}" is not a valid wei amount — rewards disabled`);
    return 0n;
  }
}

/** On-chain payment key for a merge: keccak256 of the lowercase commit SHA. */
export function mergeCommitHashBytes32(mergeCommitSha: string): `0x${string}` {
  return keccak256(toBytes(mergeCommitSha.toLowerCase()));
}

/**
 * ShipRewards deployment for a chain (audit M9): each chain has its OWN
 * pool contract. Robinhood resolves ONLY from
 * SHIP_REWARDS_ROBINHOOD_ADDRESS — never fall back to the Base address,
 * which does not exist on that chain.
 */
export function rewardsAddressForChain(chain: string): string {
  if (chain === "robinhood") return (env.SHIP_REWARDS_ROBINHOOD_ADDRESS ?? "").trim();
  return (env.SHIP_REWARDS_ADDRESS ?? "").trim();
}

export async function payRewardForMerge(args: {
  grant: GrantRecord;
  repoId: string;
  authorLogin: string;
  mergeCommitSha: string;
}): Promise<RewardResult> {
  const rewardsAddress = rewardsAddressForChain(args.grant.chain);
  if (!rewardsAddress) {
    return { paid: false, reason: `ShipRewards not configured for chain "${args.grant.chain}" — reward skipped` };
  }

  const amount = configuredRewardPerMerge();
  if (amount <= 0n) {
    return { paid: false, reason: "SHIP_REWARD_PER_MERGE is 0/unset — reward disabled" };
  }

  const linked = await listLinkedWallets(args.authorLogin);
  const recipient = linked[0]?.wallet;
  if (!recipient) {
    return {
      paid: false,
      reason: `No linked wallet for @${args.authorLogin} — reward pending until they link one`,
    };
  }

  try {
    const cfg = getVestingChainConfig(args.grant.chain as VestingChainKey);
    const account = privateKeyToAccount(env.ORACLE_PRIVATE_KEY as `0x${string}`);
    const publicClient = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
    const walletClient = createWalletClient({ account, chain: cfg.chain, transport: http(cfg.rpcUrl) });

    const commitKey = mergeCommitHashBytes32(args.mergeCommitSha);

    const alreadyPaid = await publicClient.readContract({
      address: rewardsAddress as Address,
      abi: SHIP_REWARDS_ABI,
      functionName: "isPaid",
      args: [commitKey],
    });
    if (alreadyPaid) {
      return { paid: false, reason: `Merge ${args.mergeCommitSha.slice(0, 7)} already rewarded on-chain` };
    }

    const hash = await walletClient.writeContract({
      address: rewardsAddress as Address,
      abi: SHIP_REWARDS_ABI,
      functionName: "pay",
      args: [repoIdToBytes32(args.repoId), recipient as Address, amount, commitKey],
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(
      `[ship-rewards] Paid ${amount} to ${recipient} (@${args.authorLogin}) for merge ${args.mergeCommitSha.slice(0, 7)} (tx: ${hash})`,
    );
    return { paid: true, txHash: hash, recipient, amount: amount.toString() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ship-rewards] Payment failed for ${args.grant.repoFullName}:`, msg);
    return { paid: false, reason: `ShipRewards tx failed: ${msg}` };
  }
}
