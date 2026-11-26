/**
 * Oracle count attestations (Codex round-4, blocker 1).
 *
 * A fee tranche's baseline is max(the escrow's on-chain counted
 * total, the BACKEND's counted total at lock time). Round 3 passed
 * the backend total as a bare keeper-supplied number; the escrow
 * could not verify it, and anyone can call the vault's lockAccrued
 * directly — a forged low count would credit pre-lock work, a
 * forged high count would strand the tranche.
 *
 * The count is now an EIP-712 CountAttestation signed by the
 * ORACLE key (the same signer FeeStreamEscrow already trusts for
 * release counts), binding (escrow, repoId, vault, countedTotal,
 * issuedAt, expiry, nonce). The escrow verifies the signature and
 * every binding on-chain, enforces expiry, and consumes nonces
 * monotonically per repo. This module is the issuance side: it
 * reads the backend's OWN counted total from the push counter —
 * it attests only the true count, never a requested one — takes a
 * fresh nonce from the per-repo INCR counter, and signs.
 *
 * Issuance is deliberately not access-gated beyond the server's
 * normal surface: an attestation can only ever state the backend's
 * true count at issuance, expire within ATTESTATION_TTL_SEC, and
 * be consumed once, in nonce order, for the exact escrow/repo/
 * vault it names. Holding one early buys an attacker nothing the
 * honest keeper flow does not already do at lock time.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { env } from "./env";
import { getRedis, KEYS } from "./redis";
import { getVestingChainConfig, type VestingChainKey } from "./chains";
import { repoIdFromFullName, repoIdToBytes32 } from "./repoId";

/** Attestation validity window (seconds). The keeper fetches its
 *  attestation immediately before locking; five minutes covers
 *  claim + lock submission on a congested chain while keeping the
 *  stale-attestation window small. The escrow enforces expiry. */
export const ATTESTATION_TTL_SEC = 300;

export const COUNT_ATTESTATION_TYPES = {
  CountAttestation: [
    { name: "escrow", type: "address" },
    { name: "repoId", type: "bytes32" },
    { name: "vault", type: "address" },
    { name: "countedTotal", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export type CountAttestation = {
  escrow: Address;
  repoId: Hex;
  vault: Address;
  countedTotal: string;
  issuedAt: string;
  expiry: string;
  nonce: string;
};

export type IssuedCountAttestation = {
  attestation: CountAttestation;
  signature: Hex;
  signer: Address;
};

/**
 * Issue a signed CountAttestation for (repoId, vault) on a chain,
 * attesting the backend's current counted-push total for the repo.
 * Throws when the chain has no FeeStreamEscrow configured (there is
 * no escrow to bind the attestation to) or the oracle key is unset.
 */
export async function issueCountAttestation(args: {
  repoId: string;
  vault: string;
  chain: VestingChainKey;
}): Promise<IssuedCountAttestation> {
  const cfg = getVestingChainConfig(args.chain);
  const escrow = cfg.feeStreamEscrowAddress;
  if (!escrow) {
    throw new Error(`FeeStreamEscrow not configured for ${args.chain} — cannot bind a count attestation`);
  }
  if (!env.ORACLE_PRIVATE_KEY) {
    throw new Error("ORACLE_PRIVATE_KEY not configured — cannot sign count attestations");
  }
  const repoIdHex = args.repoId.toLowerCase().replace(/^0x/, "");
  const redis = getRedis();
  const rawCount = await redis.get(KEYS.pushCount(repoIdHex));
  const countedTotal = BigInt(rawCount ? parseInt(rawCount, 10) || 0 : 0);
  const nonce = BigInt(await redis.incr(KEYS.countAttestationNonce(repoIdHex)));
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const expiry = issuedAt + BigInt(ATTESTATION_TTL_SEC);

  const account = privateKeyToAccount(env.ORACLE_PRIVATE_KEY as Hex);
  const message = {
    escrow: escrow as Address,
    repoId: repoIdToBytes32(repoIdHex),
    vault: args.vault.toLowerCase() as Address,
    countedTotal,
    issuedAt,
    expiry,
    nonce,
  };
  const signature = await account.signTypedData({
    domain: {
      name: "ProofOfDev FeeStreamEscrow",
      version: "1",
      chainId: cfg.chainId,
      verifyingContract: escrow as Address,
    },
    types: COUNT_ATTESTATION_TYPES,
    primaryType: "CountAttestation",
    message,
  });

  return {
    attestation: {
      escrow: message.escrow,
      repoId: message.repoId,
      vault: message.vault,
      countedTotal: countedTotal.toString(),
      issuedAt: issuedAt.toString(),
      expiry: expiry.toString(),
      nonce: nonce.toString(),
    },
    signature,
    signer: account.address,
  };
}

/** Convenience wrapper when the caller names the repo by full name. */
export async function issueCountAttestationForRepo(args: {
  repoFullName: string;
  vault: string;
  chain: VestingChainKey;
}): Promise<IssuedCountAttestation> {
  return issueCountAttestation({
    repoId: repoIdFromFullName(args.repoFullName),
    vault: args.vault,
    chain: args.chain,
  });
}
