/**
 * Verify personal_sign from EOAs and ERC-1271 smart wallets (Bankr Kernel, etc.).
 */

import {
  createPublicClient,
  hashMessage,
  http,
  parseAbi,
  verifyMessage,
  type Address,
  type Hex,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { env } from "./env";

const IS_TESTNET = process.env.VITE_CHAIN === "base-sepolia";
const activeChain = IS_TESTNET ? baseSepolia : base;
const RPC_URL = IS_TESTNET ? env.BASE_SEPOLIA_RPC_URL : env.BASE_RPC_URL;

const ERC1271_MAGIC = "0x1626ba7e" as const;

const ERC1271_ABI = parseAbi([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

function publicClient() {
  return createPublicClient({ chain: activeChain, transport: http(RPC_URL) });
}

async function verifyErc1271(
  address: Address,
  message: string,
  signature: Hex,
): Promise<boolean> {
  const client = publicClient();
  const code = await client.getBytecode({ address });
  if (!code || code === "0x") return false;

  const digest = hashMessage({ message });
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
): Promise<boolean> {
  try {
    if (await verifyMessage({ address, message, signature })) return true;
  } catch {
    /* EOA recovery failed — try ERC-1271 */
  }
  return verifyErc1271(address, message, signature);
}

/** True if address has contract bytecode (Bankr Kernel, smart wallet). */
export async function isSmartWalletAddress(address: Address): Promise<boolean> {
  const client = publicClient();
  const code = await client.getBytecode({ address });
  return Boolean(code && code !== "0x");
}
