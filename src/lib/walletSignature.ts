/**
 * Verify personal_sign from EOAs and ERC-1271 smart wallets (Bankr Kernel, etc.).
 */

import {
  createPublicClient,
  hashMessage,
  http,
  isHex,
  parseAbi,
  verifyMessage,
  type Address,
  type Hex,
} from "viem";
import { defaultVestingChain, getVestingChainConfig, type VestingChainKey } from "./chains";

const ERC1271_MAGIC = "0x1626ba7e" as const;

const ERC1271_ABI = parseAbi([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

function publicClient(chainKey: VestingChainKey = defaultVestingChain()) {
  const cfg = getVestingChainConfig(chainKey);
  return createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
}

function isValidSignatureHex(signature: unknown): signature is Hex {
  return typeof signature === "string" && isHex(signature) && signature.length >= 4;
}

async function verifyErc1271(
  address: Address,
  message: string,
  signature: Hex,
  chainKey: VestingChainKey = defaultVestingChain(),
): Promise<boolean> {
  const client = publicClient(chainKey);
  const code = await client.getBytecode({ address });
  if (!code || code === "0x") return false;

  const digest = hashMessage(message);
  try {
    const result = await client.readContract({
      address,
      abi: ERC1271_ABI,
      functionName: "isValidSignature",
      args: [digest, signature],
    });
    return result === ERC1271_MAGIC;
  } catch {
    return false;
  }
}

/** personal_sign verification — EOAs and smart wallets (Bankr Kernel / ERC-1271). */
export async function verifyWalletMessage(
  address: Address,
  message: string,
  signature: Hex,
  chainKey: VestingChainKey = defaultVestingChain(),
): Promise<boolean> {
  if (typeof message !== "string" || !message.trim()) return false;
  if (!isValidSignatureHex(signature)) return false;

  try {
    if (await verifyMessage({ address, message, signature })) return true;
  } catch {
    /* EOA recovery failed — try ERC-1271 */
  }
  return verifyErc1271(address, message, signature, chainKey);
}

/** True if address has contract bytecode (Bankr Kernel, smart wallet). */
export async function isSmartWalletAddress(
  address: Address,
  chainKey: VestingChainKey = defaultVestingChain(),
): Promise<boolean> {
  const client = publicClient(chainKey);
  const code = await client.getBytecode({ address });
  return Boolean(code && code !== "0x");
}
