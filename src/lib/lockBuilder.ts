/**
 * Build approve + lock transactions for agent / Bankr chat flows.
 */

import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { env } from "./env";
import knownEscrow from "../../skills/bankr-vesting/known-escrow.json";

const IS_TESTNET = process.env.VITE_CHAIN === "base-sepolia";
const activeChain = IS_TESTNET ? baseSepolia : base;
const RPC_URL = IS_TESTNET ? env.BASE_SEPOLIA_RPC_URL : env.BASE_RPC_URL;

const ESCROW_ABI = parseAbi([
  "function lock(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile) external",
  "function lockAllowance(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile) external",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function isPoolUnlocked() view returns (bool)",
]);

export type AgentTransaction = {
  step: "approve" | "lock";
  description: string;
  to: Address;
  data: Hex;
  value: "0x0";
  chainId: number;
};

export type PrepareLockParams = {
  wallet: Address;
  repoFullName: string;
  token: Address;
  /** Human-readable token amount (e.g. "3490000") */
  amount: string;
  totalPushes?: number;
  pushesPerMilestone?: number;
};

export type PrepareLockResult = {
  chain: "base" | "base-sepolia";
  tokenSymbol: string;
  tokenDecimals: number;
  amountWei: string;
  amountFormatted: string;
  streaming: boolean;
  lockFunction: "lock" | "lockAllowance";
  totalPushes: number;
  pushesPerMilestone: number;
  tokensPerMilestone: string;
  transactions: AgentTransaction[];
  needsApprove: boolean;
};

function repoIdBytes32(repoFullName: string): Hex {
  return keccak256(toBytes(repoFullName.trim()));
}

function isKnownStreamingToken(token: string): boolean {
  const t = token.toLowerCase();
  return Object.values(knownEscrow.supportedTokens).some(
    (x) => x.streaming && x.address.toLowerCase() === t,
  );
}

async function detectStreamingToken(token: Address): Promise<boolean> {
  if (isKnownStreamingToken(token)) return true;
  const client = createPublicClient({ chain: activeChain, transport: http(RPC_URL) });
  try {
    await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "isPoolUnlocked",
    });
    return true;
  } catch {
    return false;
  }
}

export async function prepareLockTransactions(params: PrepareLockParams): Promise<PrepareLockResult> {
  const escrow = env.GIT_ESCROW_ADDRESS as Address | undefined;
  if (!escrow) throw new Error("GIT_ESCROW_ADDRESS not configured on server");

  const client = createPublicClient({ chain: activeChain, transport: http(RPC_URL) });
  const totalPushes = params.totalPushes ?? 10;
  const pushesPerMilestone = params.pushesPerMilestone ?? totalPushes;

  if (totalPushes < 1 || pushesPerMilestone < 1 || totalPushes % pushesPerMilestone !== 0) {
    throw new Error("totalPushes must be a positive multiple of pushesPerMilestone");
  }

  const [decimals, symbol, balance] = await Promise.all([
    client.readContract({ address: params.token, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: params.token, abi: ERC20_ABI, functionName: "symbol" }),
    client.readContract({ address: params.token, abi: ERC20_ABI, functionName: "balanceOf", args: [params.wallet] }),
  ]);

  const amountWei = parseUnits(params.amount, decimals);
  if (amountWei <= 0n) throw new Error("amount must be greater than 0");
  if (balance < amountWei) {
    throw new Error(`Insufficient ${symbol} balance (have ${balance}, need ${amountWei})`);
  }

  const streaming = await detectStreamingToken(params.token);
  const lockFunction = streaming ? "lockAllowance" : "lock";
  const milestones = totalPushes / pushesPerMilestone;
  const tokensPerMilestone = (amountWei / BigInt(milestones)).toString();

  const lockArgs = [
    repoIdBytes32(params.repoFullName),
    params.token,
    amountWei,
    BigInt(totalPushes),
    BigInt(pushesPerMilestone),
  ] as const;

  const transactions: AgentTransaction[] = [];
  const chainId = activeChain.id;

  const allowance = await client.readContract({
    address: params.token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [params.wallet, escrow],
  });

  const needsApprove = allowance < amountWei;
  if (needsApprove) {
    transactions.push({
      step: "approve",
      description: `Approve ${params.amount} ${symbol} for GitEscrow`,
      to: params.token,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [escrow, amountWei],
      }),
      value: "0x0",
      chainId,
    });
  }

  transactions.push({
    step: "lock",
    description: `Lock ${params.amount} ${symbol} for ${params.repoFullName}`,
    to: escrow,
    data: encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: lockFunction,
      args: lockArgs,
    }),
    value: "0x0",
    chainId,
  });

  return {
    chain: IS_TESTNET ? "base-sepolia" : "base",
    tokenSymbol: symbol,
    tokenDecimals: decimals,
    amountWei: amountWei.toString(),
    amountFormatted: params.amount,
    streaming,
    lockFunction,
    totalPushes,
    pushesPerMilestone,
    tokensPerMilestone,
    transactions,
    needsApprove,
  };
}
