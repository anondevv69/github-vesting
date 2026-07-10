/**
 * Detect whether GitEscrow should use lock() or lockAllowance() for a token.
 */

import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import knownEscrow from "../../skills/bankr-vesting/known-escrow.json";
import { getVestingChainConfig, type VestingChainKey } from "./chains";

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function isPoolUnlocked() view returns (bool)",
]);

function isKnownStreamingToken(token: string, chainKey: VestingChainKey): boolean {
  const t = token.toLowerCase();
  const chainId = getVestingChainConfig(chainKey).chainId;
  const chainTokens =
    (knownEscrow as { chains?: Record<string, { supportedTokens?: typeof knownEscrow.supportedTokens }> })
      .chains?.[String(chainId)]?.supportedTokens ?? knownEscrow.supportedTokens;
  return Object.values(chainTokens).some((x) => x.streaming && x.address.toLowerCase() === t);
}

/** GitEscrow.lock pulls via transferFrom(user → escrow). Some tokens block that path. */
async function escrowPullBlocked(
  client: PublicClient,
  token: Address,
  escrow: Address,
  wallet: Address,
): Promise<boolean> {
  const allowance = await client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [wallet, escrow],
  });

  if (allowance > 0n) {
    try {
      await client.simulateContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "transferFrom",
        args: [wallet, escrow, 1n],
        account: escrow,
      });
      return false;
    } catch {
      return true;
    }
  }

  // Before approve: direct transfer to escrow is a weaker hint (some tokens allow transfer but not pull).
  try {
    await client.simulateContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [escrow, 1n],
      account: wallet,
    });
    return false;
  } catch {
    return true;
  }
}

export async function detectStreamingToken(
  token: Address,
  chainKey: VestingChainKey,
  wallet?: Address,
  escrowOverride?: Address,
): Promise<boolean> {
  if (isKnownStreamingToken(token, chainKey)) return true;

  const cfg = getVestingChainConfig(chainKey);
  const escrow = (escrowOverride ?? cfg.escrowAddress) as Address | undefined;
  if (!escrow) {
    // Hood / Bankr deploy tokens are almost always allowance-locked.
    return chainKey === "robinhood";
  }

  const client = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });

  try {
    await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "isPoolUnlocked",
    });
    return true;
  } catch {
    /* not Bankr isPoolUnlocked interface */
  }

  if (wallet) {
    return escrowPullBlocked(client, token, escrow, wallet);
  }

  return chainKey === "robinhood";
}

export type LockFunctionName = "lock" | "lockAllowance";

export async function resolveLockFunction(
  token: Address,
  chainKey: VestingChainKey,
  wallet?: Address,
): Promise<LockFunctionName> {
  const streaming = await detectStreamingToken(token, chainKey, wallet);
  return streaming ? "lockAllowance" : "lock";
}
