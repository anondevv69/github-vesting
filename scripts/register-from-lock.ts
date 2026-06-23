#!/usr/bin/env npx tsx
/**
 * Register a vesting grant in Redis after an on-chain lock (when Step 6 failed).
 *
 * Usage:
 *   npx tsx scripts/register-from-lock.ts \
 *     --tx 0xe92f96d0... \
 *     --repo owner/repo \
 *     [--installation-id 141219448]
 */

import * as dotenv from "dotenv";
dotenv.config();

import { createPublicClient, http, parseAbi, parseEventLogs } from "viem";
import { base, baseSepolia } from "viem/chains";
import { env } from "../src/lib/env";
import { handleRegister } from "../src/api/register";
import type { Request, Response } from "express";

const ESCROW_ABI = parseAbi([
  "event Locked(bytes32 indexed repoId, address indexed recipient, address indexed token, uint256 amount, uint256 totalPushesRequired, uint256 releasesPerMilestone, uint256 tokensPerMilestone)",
]);

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const txHash = getArg("--tx");
  const repoFullName = getArg("--repo");
  const installationId = getArg("--installation-id");
  const chain = (getArg("--chain") ?? "base") as "base" | "base-sepolia";

  if (!txHash || !repoFullName) {
    console.error("Usage: --tx <lockTxHash> --repo owner/name [--installation-id N]");
    process.exit(1);
  }

  const viemChain = chain === "base" ? base : baseSepolia;
  const rpc = chain === "base" ? env.BASE_RPC_URL : env.BASE_SEPOLIA_RPC_URL;
  const client = createPublicClient({ chain: viemChain, transport: http(rpc) });
  const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  const logs = parseEventLogs({ abi: ESCROW_ABI, logs: receipt.logs, eventName: "Locked" });
  const locked = logs[0]?.args;
  if (!locked) throw new Error("No Locked event in transaction");

  const body = {
    repoFullName,
    platform: "github" as const,
    recipient: locked.recipient,
    token: locked.token,
    chain,
    totalLocked: locked.amount.toString(),
    totalPushesRequired: Number(locked.totalPushesRequired),
    pushesPerMilestone: Number(locked.releasesPerMilestone),
    tokensPerMilestone: locked.tokensPerMilestone.toString(),
    onChainTxHash: txHash,
    installationId: installationId ? Number(installationId) : undefined,
    streaming: true,
  };

  const mockRes = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return this;
    },
  };

  await handleRegister({ body } as Request, mockRes as unknown as Response);
  console.log(JSON.stringify({ status: mockRes.statusCode, body: mockRes.body }, null, 2));
  if (mockRes.statusCode >= 400) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
