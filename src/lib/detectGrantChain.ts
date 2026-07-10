/**
 * Infer vesting chain from a lock transaction hash (escrow Locked event).
 */

import { createPublicClient, http, parseAbi, parseEventLogs, type Hash } from "viem";
import { getVestingChainConfig, type VestingChainKey } from "./chains";

const ESCROW_ABI = parseAbi([
  "event Locked(bytes32 indexed repoId, address indexed recipient, address indexed token, uint256 amount, uint256 totalPushesRequired, uint256 releasesPerMilestone, uint256 tokensPerMilestone)",
]);

const CHAINS_TO_PROBE: VestingChainKey[] = ["robinhood", "base", "base-sepolia"];

export async function detectChainFromLockTx(txHash: string): Promise<VestingChainKey | null> {
  const hash = txHash.trim() as Hash;
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) return null;

  for (const key of CHAINS_TO_PROBE) {
    const cfg = getVestingChainConfig(key);
    if (!cfg.escrowAddress) continue;
    try {
      const client = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
      const receipt = await client.getTransactionReceipt({ hash });
      if (!receipt || receipt.status !== "success") continue;

      const fromEscrow = receipt.to?.toLowerCase() === cfg.escrowAddress.toLowerCase();
      const logs = parseEventLogs({ abi: ESCROW_ABI, logs: receipt.logs, eventName: "Locked" });
      if (fromEscrow || logs.length > 0) return key;
    } catch {
      /* tx not on this chain */
    }
  }
  return null;
}
