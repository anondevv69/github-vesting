/**
 * Ship reward oracle (spec §8B): on every COUNTED merged PR, pay the flat
 * per-merge reward from the pre-funded ShipRewards pool to the PR author's
 * linked wallet. Rewards fire whether or not the repo has a vesting grant
 * (audit H1) — the grant path and the grant-less path share
 * `payRewardForMerge` below.
 *
 * Unlinked authors (audit H2): the reward is NOT lost. It accrues as a
 * pending record (lib/pendingRewards.ts) at the amount configured at earn
 * time, and `settlePendingRewardsForLogin` pays the backlog out to a
 * wallet the moment one is linked for that login (any link flow funnels
 * through `addLinkedWallet`, which triggers settlement).
 *
 * Safety rails:
 *  - No-ops (paid: false, with a reason) when ShipRewards is not configured
 *    for the chain or when SHIP_REWARD_PER_MERGE is unset/0/unparseable.
 *    Nothing accrues in those cases either — there is no pool to pay from.
 *  - On-chain idempotency: ShipRewards.paid[mergeCommitHash] is checked
 *    before sending, and the contract itself refuses a second payment.
 *    Recording a pending reward is also idempotent per merge SHA.
 *  - Never throws into the push/link pipelines — failures are logged and
 *    returned; a failed settlement leaves the entry pending for next time.
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
import {
  listPendingRewards,
  recordPendingReward,
  removePendingReward,
  type PendingReward,
} from "../lib/pendingRewards";
import { resolveShipReport, recordPushSettlement } from "../api/shipReport";

const SHIP_REWARDS_ABI = parseAbi([
  "function pay(bytes32 repoId, address recipient, uint256 amount, bytes32 mergeCommitHash) external",
  "function isPaid(bytes32 mergeCommitHash) view returns (bool)",
  "event Paid(bytes32 indexed repoId, address indexed recipient, uint256 amount, bytes32 indexed mergeCommitHash)",
]);

export type RewardResult =
  | { paid: true; txHash: string; recipient: string; amount: string }
  | {
      paid: false;
      reason: string;
      /** True when the reward was recorded as pending (author unlinked). */
      pending?: boolean;
      /** True when the merge was already rewarded on-chain earlier. */
      alreadyPaid?: boolean;
    };

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
 * Reviewer swarm reward per PASS reviewer in a counted push's quorum,
 * in token wei. Config: SHIP_REVIEWER_REWARD_PER_MERGE (env). Unset →
 * 10% of the base per-merge reward — a LABELLED PLACEHOLDER: the
 * reviewer share of the schedule is Gregory's open decision (§8B.2),
 * not a product constant. 0 disables reviewer rewards.
 */
export function configuredReviewerReward(): bigint {
  const raw = (env.SHIP_REVIEWER_REWARD_PER_MERGE ?? "").trim();
  if (raw) {
    try {
      return parseWei(raw);
    } catch {
      console.warn(`[ship-rewards] SHIP_REVIEWER_REWARD_PER_MERGE="${raw}" is not a valid wei amount — reviewer rewards disabled`);
      return 0n;
    }
  }
  return configuredRewardPerMerge() / 10n;
}

/**
 * On-chain payment key for ONE reviewer's reward on ONE merge. The
 * pool's paid[] map is keyed per merge hash, so a reviewer payment
 * needs its own derived key (merge SHA + reviewer wallet) or it would
 * collide with the author's payment for the same merge. The derived
 * key keeps the same two-layer idempotency: the oracle checks
 * isPaid(derivedKey) before sending, and the contract refuses a
 * second payment under it — webhook replays can never double-pay a
 * reviewer.
 */
export function reviewerPaymentKey(mergeCommitSha: string, reviewerWallet: string): string {
  return `${mergeCommitSha.toLowerCase()}:reviewer:${reviewerWallet.toLowerCase()}`;
}

export type ReviewerRewardOutcome = {
  reviewerLogin: string;
  reviewerWallet: string;
  result: RewardResult;
};

/**
 * Pay the PASS reviewers whose reviews formed the quorum for a push
 * that has JUST counted. Called only from the webhook counting path
 * (processPush), after the verifier counted the push — reviewer
 * attestations themselves never reach this function (design law,
 * lib/swarmReview.ts). Reviewers are paid to their linked wallet
 * (most recently linked, same rule as authors); a reviewer whose
 * wallet has vanished accrues the reward as pending under the derived
 * payment key, settling on their next wallet link like author
 * accruals. Never throws.
 */
export async function payReviewerRewardsForMerge(args: {
  chain: string;
  repoId: string;
  repoFullName: string;
  mergeCommitSha: string;
  reviewers: Array<{ reviewerLogin: string }>;
}): Promise<ReviewerRewardOutcome[]> {
  const outcomes: ReviewerRewardOutcome[] = [];
  if (args.reviewers.length === 0) return outcomes;
  if (!rewardsAddressForChain(args.chain)) return outcomes;

  const amount = configuredReviewerReward();
  if (amount <= 0n) return outcomes;

  for (const { reviewerLogin } of args.reviewers) {
    try {
      const linked = await listLinkedWallets(reviewerLogin);
      const wallet = linked[0]?.wallet;
      if (!wallet) {
        await recordPendingReward({
          login: reviewerLogin.toLowerCase(),
          repoId: args.repoId,
          repoFullName: args.repoFullName,
          mergeSha: reviewerPaymentKey(args.mergeCommitSha, reviewerLogin),
          amount: amount.toString(),
          chain: args.chain,
          earnedAt: new Date().toISOString(),
        });
        outcomes.push({
          reviewerLogin,
          reviewerWallet: "",
          result: {
            paid: false,
            pending: true,
            reason: `No linked wallet for reviewer @${reviewerLogin} — reviewer reward accrued as pending`,
          },
        });
        continue;
      }
      const result = await payReward({
        chain: args.chain,
        repoId: args.repoId,
        recipient: wallet,
        mergeCommitSha: reviewerPaymentKey(args.mergeCommitSha, wallet),
        amount,
      });
      outcomes.push({ reviewerLogin, reviewerWallet: wallet, result });
    } catch (err) {
      console.error(`[ship-rewards] Reviewer reward failed for @${reviewerLogin}:`, err);
    }
  }
  return outcomes;
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

/**
 * The single payment primitive: pay `amount` wei of the chain's reward
 * token to `recipient` for one merge, from that chain's ShipRewards pool.
 * Used by both the immediate path (counted merge, author linked) and
 * settlement of accrued pending rewards. Never throws.
 */
export async function payReward(args: {
  chain: string;
  repoId: string;
  recipient: string;
  mergeCommitSha: string;
  amount: bigint;
}): Promise<RewardResult> {
  const rewardsAddress = rewardsAddressForChain(args.chain);
  if (!rewardsAddress) {
    return { paid: false, reason: `ShipRewards not configured for chain "${args.chain}" — reward skipped` };
  }
  if (args.amount <= 0n) {
    return { paid: false, reason: "Reward amount is 0 — nothing to pay" };
  }

  try {
    const cfg = getVestingChainConfig(args.chain as VestingChainKey);
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
      return {
        paid: false,
        alreadyPaid: true,
        reason: `Merge ${args.mergeCommitSha.slice(0, 7)} already rewarded on-chain`,
      };
    }

    const hash = await walletClient.writeContract({
      address: rewardsAddress as Address,
      abi: SHIP_REWARDS_ABI,
      functionName: "pay",
      args: [repoIdToBytes32(args.repoId), args.recipient as Address, args.amount, commitKey],
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(
      `[ship-rewards] Paid ${args.amount} to ${args.recipient} for merge ${args.mergeCommitSha.slice(0, 7)} (tx: ${hash})`,
    );
    return { paid: true, txHash: hash, recipient: args.recipient, amount: args.amount.toString() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ship-rewards] Payment failed for merge ${args.mergeCommitSha.slice(0, 7)}:`, msg);
    return { paid: false, reason: `ShipRewards tx failed: ${msg}` };
  }
}

/**
 * Reward for one counted merge, addressed to its author. Pays immediately
 * when the author has a linked wallet (most recently linked — the store is
 * newest-first); otherwise records a pending reward that settles when a
 * wallet gets linked. Shared by the grant path and the grant-less path.
 */
export async function payRewardForMerge(args: {
  chain: string;
  repoId: string;
  repoFullName: string;
  authorLogin: string;
  mergeCommitSha: string;
}): Promise<RewardResult> {
  if (!rewardsAddressForChain(args.chain)) {
    return { paid: false, reason: `ShipRewards not configured for chain "${args.chain}" — reward skipped` };
  }

  const amount = configuredRewardPerMerge();
  if (amount <= 0n) {
    return { paid: false, reason: "SHIP_REWARD_PER_MERGE is 0/unset — reward disabled" };
  }

  const linked = await listLinkedWallets(args.authorLogin);
  const recipient = linked[0]?.wallet;
  if (recipient) {
    return payReward({
      chain: args.chain,
      repoId: args.repoId,
      recipient,
      mergeCommitSha: args.mergeCommitSha,
      amount,
    });
  }

  // Audit H2: accrue instead of dropping. The amount is captured NOW, so a
  // later config change never re-prices an already-earned reward.
  await recordPendingReward({
    login: args.authorLogin.toLowerCase(),
    repoId: args.repoId,
    repoFullName: args.repoFullName,
    mergeSha: args.mergeCommitSha.toLowerCase(),
    amount: amount.toString(),
    chain: args.chain,
    earnedAt: new Date().toISOString(),
  });
  return {
    paid: false,
    pending: true,
    reason:
      `No linked wallet for @${args.authorLogin} — reward accrued as pending; ` +
      `it pays out automatically when they link a wallet`,
  };
}

export type PendingSettlement = {
  paidCount: number;
  paidTotal: string;
  resolvedCount: number;
  remaining: number;
};

/**
 * Pay out every pending reward for `login` to `wallet` (the wallet that was
 * just linked). Called from `addLinkedWallet`, so EVERY link path triggers
 * it. Partial failures (pool empty, tx reverts, chain unconfigured) leave
 * the affected entries pending and logged — the next link retries them.
 * Entries whose merge is already paid on-chain are dropped as resolved.
 * Never throws.
 */
export async function settlePendingRewardsForLogin(
  login: string,
  wallet: string,
): Promise<PendingSettlement> {
  const result: PendingSettlement = { paidCount: 0, paidTotal: "0", remaining: 0, resolvedCount: 0 };
  try {
    const pending = await listPendingRewards(login);
    if (pending.length === 0) return result;

    let paidTotal = 0n;
    for (const entry of pending) {
      let amount: bigint;
      try {
        amount = BigInt(entry.amount);
      } catch {
        console.warn(`[ship-rewards] Pending reward for @${login} has unparseable amount "${entry.amount}" — leaving pending`);
        result.remaining++;
        continue;
      }

      const pay = await payReward({
        chain: entry.chain,
        repoId: entry.repoId,
        recipient: wallet,
        mergeCommitSha: entry.mergeSha,
        amount,
      });

      if (pay.paid) {
        await removePendingReward(login, entry.mergeSha);
        result.paidCount++;
        result.resolvedCount++;
        paidTotal += amount;
        // If a ship report is still open for this merge, it can now
        // honestly read "paid" — settlement came late, via the link.
        // Record the evidence as well, so a report filed after this
        // settlement reconciles to "paid" too.
        await recordPushSettlement(entry.repoFullName, entry.mergeSha, {
          rewardTxHash: pay.txHash,
          rewardRecipient: pay.recipient,
          rewardAmount: pay.amount,
        });
        await resolveShipReport(entry.repoFullName, entry.mergeSha, {
          kind: "counted",
          reason: "Accrued merge reward settled on wallet link",
          rewardTxHash: pay.txHash,
          rewardRecipient: pay.recipient,
          rewardAmount: pay.amount,
        });
      } else if (pay.alreadyPaid) {
        // Paid on-chain through some other path — the pending record is
        // settled history, not a payable. Drop it so it can't double-pay.
        await removePendingReward(login, entry.mergeSha);
        result.resolvedCount++;
        console.log(
          `[ship-rewards] Pending reward for @${login} (merge ${entry.mergeSha.slice(0, 7)}) already paid on-chain — cleared`,
        );
      } else {
        result.remaining++;
        console.warn(
          `[ship-rewards] Pending reward for @${login} (merge ${entry.mergeSha.slice(0, 7)}) not settled: ${pay.reason}`,
        );
      }
    }
    result.paidTotal = paidTotal.toString();
    if (result.paidCount > 0) {
      console.log(
        `[ship-rewards] Settled ${result.paidCount} pending reward(s) for @${login} → ${wallet} (total ${result.paidTotal} wei, ${result.remaining} still pending)`,
      );
    }
  } catch (err) {
    console.error(`[ship-rewards] Pending settlement failed for @${login}:`, err);
  }
  return result;
}
