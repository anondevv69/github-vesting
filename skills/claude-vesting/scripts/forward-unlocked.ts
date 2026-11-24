/**
 * forward-unlocked.ts — the agent-wallet forwarder (agent-managed setup).
 *
 * An agent that set up a Proof of Dev lock from its OWN wallet (because
 * the human has no wallet / wants a one-prompt setup) is the escrow's
 * recipient: releases land in the agent's wallet. This script is the
 * agent wallet's ONLY other job: forward whatever the escrow released
 * to the owner's wallet.
 *
 * Safety model:
 * - The agent key is read from a local file (env AGENT_WALLET_KEY_FILE,
 *   default ~/.pod_agent_key) and is NEVER printed, logged, or sent.
 * - A one-time "reserve" snapshot (the agent's token balance when the
 *   forwarder first runs — i.e. the unvested supply the agent keeps)
 *   is stored next to the key. Only balance ABOVE the reserve is ever
 *   forwarded, so the forwarder can never touch unvested supply.
 * - It sends ONE token to ONE configured owner address. Nothing else.
 *
 * Usage:
 *   AGENT_TOKEN=<erc20> AGENT_OWNER=<owner wallet> \
 *   npx hardhat run skills/claude-vesting/scripts/forward-unlocked.ts --network base
 *
 * Run it after any counted push (or on a schedule). Exit 0 with
 * "nothing to forward" is the normal no-op.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const keyFile = process.env.AGENT_WALLET_KEY_FILE ?? "/home/hatch/.pod_agent_key";
  const tokenAddr = process.env.AGENT_TOKEN;
  const owner = process.env.AGENT_OWNER;
  if (!tokenAddr || !owner) throw new Error("Set AGENT_TOKEN and AGENT_OWNER");
  if (!ethers.isAddress(tokenAddr) || !ethers.isAddress(owner)) throw new Error("Bad address");

  const key = fs.readFileSync(keyFile, "utf8").trim();
  const agent = new ethers.Wallet(key, ethers.provider);
  if (agent.address.toLowerCase() === owner.toLowerCase()) {
    throw new Error("Owner must differ from the agent wallet");
  }

  const token = await ethers.getContractAt("MockERC20", tokenAddr, agent);
  const balance: bigint = await token.balanceOf(agent.address);

  // Reserve = the balance the first run ever saw (unvested supply).
  const stateFile = path.join(path.dirname(keyFile), ".pod_agent_forward_state.json");
  let reserve: bigint;
  if (fs.existsSync(stateFile)) {
    reserve = BigInt(JSON.parse(fs.readFileSync(stateFile, "utf8")).reserve);
  } else {
    reserve = balance;
    fs.writeFileSync(stateFile, JSON.stringify({ reserve: reserve.toString(), token: tokenAddr, owner }), { mode: 0o600 });
    console.log(`reserve initialized at ${ethers.formatUnits(reserve, 18)} (unvested supply stays with the agent)`);
  }

  const forwardable = balance > reserve ? balance - reserve : 0n;
  if (forwardable === 0n) {
    console.log("nothing to forward — no new unlocked tokens");
    return;
  }
  const tx = await token.transfer(owner, forwardable);
  await tx.wait();
  console.log(`forwarded ${ethers.formatUnits(forwardable, 18)} unlocked tokens to owner ${owner}: ${tx.hash}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
