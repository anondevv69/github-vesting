/**
 * forward-unlocked.ts — the agent-wallet forwarder (agent-managed setup).
 *
 * An agent that set up a Proof of Dev lock from its OWN wallet (because
 * the human has no wallet / wants a one-prompt setup) is the escrow's
 * recipient: releases land in the agent's wallet. This script is the
 * agent wallet's ONLY other job: forward whatever the escrow released
 * to the owner.
 *
 * Two delivery modes:
 * - PLAIN (AGENT_OWNER=0x…): transfer to the owner's wallet address.
 * - STEALTH (AGENT_OWNER_META=st:eth:0x…): the owner shares only a
 *   stealth META-address (ERC-5564) — no wallet address anywhere. Each
 *   forward derives a FRESH one-time stealth address, sends the tokens
 *   there plus a small ETH dust (so the owner can pay gas to move
 *   them), and posts the ERC-5564 announcement the owner's scanner
 *   needs to discover the payment and recover its spend key.
 *
 * Safety model:
 * - The agent key is read from a local file (env AGENT_WALLET_KEY_FILE,
 *   default ~/.pod_agent_key) and is NEVER printed, logged, or sent.
 * - The state file tracks the agent's OWN token balance ("own"): the
 *   balance when the forwarder first ran, minus any later locks the
 *   agent registered with --register-lock. Only balance ABOVE "own"
 *   (i.e. exactly what the escrow released) is ever forwarded, so the
 *   forwarder can never touch unvested supply.
 * - It sends ONE token to ONE owner (address or meta-address). Nothing
 *   else. The stealth derivation follows ERC-5564 / ScopeLift exactly:
 *   tweak = keccak256(compressed ECDH shared secret), stealth pubkey =
 *   spending pubkey + tweak·G, view tag = first tweak byte.
 *
 * Usage:
 *   AGENT_TOKEN=<erc20> AGENT_OWNER=<owner wallet> \
 *   npx hardhat run skills/claude-vesting/scripts/forward-unlocked.ts --network base
 *   # or stealth:
 *   AGENT_TOKEN=<erc20> AGENT_OWNER_META=st:eth:0x… [AGENT_DUST_ETH=0.0002] \
 *   npx hardhat run skills/claude-vesting/scripts/forward-unlocked.ts --network base
 *   # after locking more from this wallet:
 *   AGENT_REGISTER_LOCK=500 ... forward-unlocked.ts --network base
 *
 * Run it after any counted push (or on a schedule). Exit 0 with
 * "nothing to forward" is the normal no-op.
 */
import { ethers } from "hardhat";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as fs from "fs";
import * as path from "path";

const ANNOUNCER = "0x55649E01B5Df198D18D95b5cc5051630cfD45564";
const ANNOUNCER_ABI = [
  "function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata) external",
];

interface StealthPayment {
  stealthAddress: string;
  ephemeralPubKey: string; // 0x + 33-byte compressed
  viewTag: number;
}

/** ERC-5564 payer-side derivation, identical math to Agent Private Pay. */
function deriveStealth(metaAddress: string): StealthPayment {
  const s = metaAddress.trim().replace(/^st:eth:/, "").replace(/^0x/, "");
  const raw = Buffer.from(s, "hex");
  if (raw.length !== 66) throw new Error("meta-address must be 66 bytes (two compressed pubkeys)");
  const spendPt = secp256k1.ProjectivePoint.fromHex(raw.subarray(0, 33).toString("hex"));
  const viewPt = secp256k1.ProjectivePoint.fromHex(raw.subarray(33, 66).toString("hex"));

  const ephScalar = BigInt(ethers.Wallet.createRandom().privateKey);
  const ephPt = secp256k1.ProjectivePoint.BASE.multiply(ephScalar);
  const shared = viewPt.multiply(ephScalar);
  const sharedCompressed = Buffer.from(shared.toRawBytes(true));
  const tweakHex = ethers.keccak256(sharedCompressed);
  const tweak = BigInt(tweakHex);
  const stealthPt = spendPt.add(secp256k1.ProjectivePoint.BASE.multiply(tweak));
  const uncompressed = Buffer.from(stealthPt.toRawBytes(false)); // 0x04 || x || y
  const addrHash = ethers.keccak256(uncompressed.subarray(1));
  return {
    stealthAddress: ethers.getAddress("0x" + addrHash.slice(-40)),
    ephemeralPubKey: "0x" + Buffer.from(ephPt.toRawBytes(true)).toString("hex"),
    viewTag: parseInt(tweakHex.slice(2, 4), 16),
  };
}

function erc5564Metadata(viewTag: number, token: string, amount: bigint): string {
  const buf = Buffer.alloc(1 + 20 + 32);
  buf[0] = viewTag;
  Buffer.from(token.replace(/^0x/, ""), "hex").copy(buf, 1);
  Buffer.from(amount.toString(16).padStart(64, "0"), "hex").copy(buf, 21);
  return "0x" + buf.toString("hex");
}

async function main() {
  const keyFile = process.env.AGENT_WALLET_KEY_FILE ?? "/home/hatch/.pod_agent_key";
  const tokenAddr = process.env.AGENT_TOKEN;
  const owner = process.env.AGENT_OWNER;
  const ownerMeta = process.env.AGENT_OWNER_META;
  const dustEth = process.env.AGENT_DUST_ETH ?? "0.0002";
  if (!tokenAddr) throw new Error("Set AGENT_TOKEN");
  if (!owner && !ownerMeta) throw new Error("Set AGENT_OWNER (plain) or AGENT_OWNER_META (stealth)");
  if (owner && ownerMeta) throw new Error("Set only one of AGENT_OWNER / AGENT_OWNER_META");
  if (!ethers.isAddress(tokenAddr)) throw new Error("Bad token address");
  if (owner && !ethers.isAddress(owner)) throw new Error("Bad owner address");

  const key = fs.readFileSync(keyFile, "utf8").trim();
  const agent = new ethers.Wallet(key, ethers.provider);
  if (owner && agent.address.toLowerCase() === owner.toLowerCase()) {
    throw new Error("Owner must differ from the agent wallet");
  }

  const token = await ethers.getContractAt("MockERC20", tokenAddr, agent);
  const decimals: number = await token.decimals();
  const balance: bigint = await token.balanceOf(agent.address);

  // State: the agent's OWN balance baseline. Migrates the v1 "reserve".
  const stateFile = path.join(path.dirname(keyFile), ".pod_agent_forward_state.json");
  let state: { own: string; token: string; owner?: string; ownerMeta?: string };
  if (fs.existsSync(stateFile)) {
    const rawState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state = {
      own: rawState.own ?? rawState.reserve,
      token: rawState.token,
      owner: rawState.owner,
      ownerMeta: rawState.ownerMeta,
    };
    if (state.token.toLowerCase() !== tokenAddr.toLowerCase()) {
      throw new Error("State file is for a different token — refusing");
    }
  } else {
    state = {
      own: balance.toString(),
      token: tokenAddr,
      ...(owner ? { owner } : {}),
      ...(ownerMeta ? { ownerMeta } : {}),
    };
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    console.log(`own-balance baseline initialized at ${ethers.formatUnits(balance, decimals)} (unvested supply stays with the agent)`);
  }
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });

  // Register a lock (AGENT_REGISTER_LOCK=<amount>, or --register-lock
  // <amount> when the runner passes argv through): the agent locked
  // more of its own supply; lower the baseline so the lock is never
  // mistaken for a release.
  const regIdx = process.argv.indexOf("--register-lock");
  const regAmount = process.env.AGENT_REGISTER_LOCK ?? (regIdx >= 0 ? process.argv[regIdx + 1] : undefined);
  if (regAmount !== undefined) {
    const amount = ethers.parseUnits(regAmount, decimals);
    const newOwn = BigInt(state.own) - amount;
    if (newOwn < 0n) throw new Error("register-lock exceeds baseline");
    state.own = newOwn.toString();
    save();
    console.log(`lock registered: own-balance baseline now ${ethers.formatUnits(newOwn, decimals)}`);
    return;
  }

  const own = BigInt(state.own);
  const forwardable = balance > own ? balance - own : 0n;
  if (forwardable === 0n) {
    console.log("nothing to forward — no new unlocked tokens");
    return;
  }

  if (owner) {
    state.owner = owner;
    delete state.ownerMeta;
    save();
    const tx = await token.transfer(owner, forwardable);
    await tx.wait();
    console.log(`forwarded ${ethers.formatUnits(forwardable, decimals)} unlocked tokens to owner ${owner}: ${tx.hash}`);
    return;
  }

  // Stealth mode: fresh one-time address per forward.
  state.ownerMeta = ownerMeta;
  delete state.owner;
  save();
  const pay = deriveStealth(ownerMeta!);
  if (pay.stealthAddress.toLowerCase() === agent.address.toLowerCase()) {
    throw new Error("Derived stealth address collides with the agent wallet — refusing");
  }
  const dust = ethers.parseEther(dustEth);
  const dustTx = await agent.sendTransaction({ to: pay.stealthAddress, value: dust });
  await dustTx.wait();
  const tokenTx = await token.transfer(pay.stealthAddress, forwardable);
  await tokenTx.wait();
  const announcer = new ethers.Contract(ANNOUNCER, ANNOUNCER_ABI, agent);
  const metadata = erc5564Metadata(pay.viewTag, tokenAddr, forwardable);
  const annTx = await announcer.announce(1, pay.stealthAddress, pay.ephemeralPubKey, metadata);
  await annTx.wait();
  console.log(
    `stealth-forwarded ${ethers.formatUnits(forwardable, decimals)} unlocked tokens to one-time address ${pay.stealthAddress} ` +
    `(view tag ${pay.viewTag}); dust tx ${dustTx.hash}; token tx ${tokenTx.hash}; announcement tx ${annTx.hash}`
  );
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
