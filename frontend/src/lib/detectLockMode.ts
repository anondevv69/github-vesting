/**
 * Detect lock() vs lockAllowance() for frontend create flow.
 */

import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { getFrontendChainConfig, type VestingChainKey } from "./chains";

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function isPoolUnlocked() view returns (bool)",
]);

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
  const cfg = getFrontendChainConfig(chainKey);
  const escrow = escrowOverride ?? cfg.escrowAddress;
  if (!escrow) {
    return false;
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
    /* continue */
  }

  if (wallet) {
    return escrowPullBlocked(client, token, escrow, wallet);
  }

  return false;
}

export function defaultLockFunction(_chainKey: VestingChainKey): "lock" | "lockAllowance" {
  return "lock";
}
