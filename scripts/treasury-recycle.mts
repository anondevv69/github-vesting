/**
 * Treasury recycle keeper (Proof of Dev §8B/§13 design, made operational
 * 2026-11-26): the platform reward treasury's accrued POD trading fees
 * are claimed, converted to POD, and topped into the ShipRewards pool —
 * launchpad fees refill the rewards that counted merges pay out.
 *
 * Cycle (every step chain-derived; the script keeps no local state, so
 * re-runs and overlapping invocations are safe — a lockfile also
 * serialises concurrent runs):
 *   1. CLAIM  — read the treasury's claimable POD fees via the Bankr
 *      launch SDK (fees.get). If > 0, build the claim (SDK buildClaim),
 *      assert the produced call(s) target the Bankr claim ledger with a
 *      collectFees-family selector and zero value, simulate from the
 *      treasury, then send treasury-signed. Claims pay the pool's quote
 *      asset (ANTc for POD) and any token-side fees (POD) to the
 *      treasury itself — the ledger pays msg.sender.
 *   2. SWAP   — the treasury's whole ANTc balance (skipped below a dust
 *      threshold) is swapped ANTc → POD through PodSettler against the
 *      POD/ANTc Doppler v4 pool (hand-rolled Universal Router calls
 *      revert on the Bankr hook — §9/§22). The swap is simulated first;
 *      minOut is 97% of the simulated output (a real bound, re-derived
 *      every run).
 *   3. TOP UP — the treasury's whole POD balance is transferred into
 *      the ShipRewards pool (funding is a plain ERC-20 transfer by
 *      contract design). Refuses to deposit unless the pool's
 *      rewardToken actually is POD (fail-closed against a stale or
 *      re-repointed config).
 *
 * Usage:
 *   npx tsx scripts/treasury-recycle.mts            # full cycle
 *   DRY_RUN=1 npx tsx scripts/treasury-recycle.mts  # simulate only
 *
 * Config (env, production defaults shown):
 *   TREASURY_WALLET_FILE   hidden_files/treasury-wallet.json (key record;
 *                          the key is read in-process only, never logged)
 *   TREASURY_ADDRESS       0x9F1019CC208eD1786a85d19C616A017cd1cB5291
 *   POD_TOKEN_ADDRESS      0x56a92c2453578897C0682c2D46488DC217e57D4e
 *   POD_QUOTE_ADDRESS      0xb20000000000000000000016e38FD364d271Ba28 (ANTc)
 *   SHIP_REWARDS_ADDRESS   0x0Bea0333d57B2D5506fbCa3Eab36078df77AD82E
 *   BANKR_CLAIM_LEDGER_ADDRESS 0x7C836e937831Cd5931A1ACbB9117dF9714D7d1F7
 *   POD_SETTLER_ADDRESS    0xe9a8ce38c1acd7a34de835e790cc20bdad41eafb
 *   BASE_RPC_URL           https://base-rpc.publicnode.com
 *   RECYCLE_MIN_SWAP_ANTC  100000 (0.001 ANTc) — dust floor for the swap
 *   RECYCLE_SLIPPAGE_BPS   300 (3%) — minOut bound under the simulation
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  formatEther,
  getAddress,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  parseAbi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createLaunchClient } from "@bankr/launch-sdk";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILDER_DATA_SUFFIX } from "../src/lib/builderCode";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com";
const DRY_RUN = process.env.DRY_RUN === "1";

const TREASURY = getAddress(process.env.TREASURY_ADDRESS || "0x9F1019CC208eD1786a85d19C616A017cd1cB5291");
const POD = getAddress(process.env.POD_TOKEN_ADDRESS || "0x56a92c2453578897C0682c2D46488DC217e57D4e");
const ANTC = getAddress(process.env.POD_QUOTE_ADDRESS || "0xb20000000000000000000016e38FD364d271Ba28");
const SHIP_REWARDS = getAddress(process.env.SHIP_REWARDS_ADDRESS || "0x0Bea0333d57B2D5506fbCa3Eab36078df77AD82E");
const CLAIM_LEDGER = getAddress(process.env.BANKR_CLAIM_LEDGER_ADDRESS || "0x7C836e937831Cd5931A1ACbB9117dF9714D7d1F7");
const SETTLER = getAddress(process.env.POD_SETTLER_ADDRESS || "0xe9a8ce38c1acd7a34de835e790cc20bdad41eafb");
const HOOK = getAddress("0xf8Df392d399aF9c1235B02e5df8c56fEdb7978Cc");
const MIN_SWAP_ANTC = BigInt(process.env.RECYCLE_MIN_SWAP_ANTC || "100000"); // 0.001 ANTc (8dp)
const SLIPPAGE_BPS = BigInt(process.env.RECYCLE_SLIPPAGE_BPS || "300");

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
]);
const SETTLER_ABI = [
  {
    type: "function", name: "swapExactInput", stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "tuple", components: [
        { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] },
      { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" },
      { name: "minOut", type: "uint128" }, { name: "recipient", type: "address" }, { name: "hookData", type: "bytes" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
const SHIP_ABI = parseAbi([
  "function rewardToken() view returns (address)",
  "function rewardBalance() view returns (uint256)",
]);
// collectFees(bytes32) / collectFeesMany(bytes32[]) /
// collectFeesSide(bytes32,bool) selectors (computed from the SDK's
// BankrFeeLedger ABI signatures).
const CLAIM_SELECTORS = new Set(["0x817db73b", "0x865032c4", "0xa49d53b3"]);

function log(step: string, msg: string) {
  console.log(`[treasury-recycle][${step}] ${msg}`);
}
function treasuryKey(): `0x${string}` {
  const file = process.env.TREASURY_WALLET_FILE || join(REPO_ROOT, "hidden_files", "treasury-wallet.json");
  const raw = String(JSON.parse(readFileSync(file, "utf8")).privateKey).trim();
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
}

async function main() {
  // Serialise concurrent runs (cron overlap): a stale lock older than
  // 30 minutes is ignored.
  const lockPath = join("/tmp", `treasury-recycle-${TREASURY.toLowerCase()}.lock`);
  if (existsSync(lockPath)) {
    const ageMs = Date.now() - Number(readFileSync(lockPath, "utf8") || "0");
    if (ageMs < 30 * 60 * 1000) { log("lock", "another recycle run is in progress — no-op"); return; }
  }
  writeFileSync(lockPath, String(Date.now()));
  try {
    await run();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

async function run() {
  const account = privateKeyToAccount(treasuryKey());
  if (account.address.toLowerCase() !== TREASURY.toLowerCase()) {
    throw new Error(`treasury key derives ${account.address}, expected ${TREASURY} — refusing to run`);
  }
  const p = createPublicClient({ chain: base, transport: http(RPC) });
  const w = createWalletClient({ account, chain: base, transport: http(RPC), dataSuffix: BUILDER_DATA_SUFFIX });
  const lc = createLaunchClient({ chain: "base", publicClient: p, walletClient: w });

  const eth = await p.getBalance({ address: TREASURY });
  log("start", `treasury ${TREASURY} ETH ${formatEther(eth)}${DRY_RUN ? " (DRY RUN)" : ""}`);
  if (eth === 0n) throw new Error("treasury holds no ETH for gas — refusing to run");

  // Fail-closed: never deposit into a pool that is not paying POD.
  const poolToken = await p.readContract({ address: SHIP_REWARDS, abi: SHIP_ABI, functionName: "rewardToken" });
  if (poolToken.toLowerCase() !== POD.toLowerCase()) {
    throw new Error(`ShipRewards rewardToken is ${poolToken}, not POD ${POD} — refusing to recycle`);
  }

  // ── 1. CLAIM ────────────────────────────────────────────────────────
  const fees: any = await lc.fees.get(POD, TREASURY);
  const claimableQuote: bigint = fees.claimableQuote;
  const claimableToken: bigint = fees.claimableToken;
  log("claim", `claimable: ${formatUnits(claimableQuote, 8)} ANTc, ${formatUnits(claimableToken, 18)} POD`);
  if (claimableQuote > 0n || claimableToken > 0n) {
    const txs = await lc.fees.buildClaim(POD, TREASURY);
    for (const tx of txs as any[]) {
      const data = String(tx.data ?? "").toLowerCase();
      if (String(tx.to).toLowerCase() !== CLAIM_LEDGER.toLowerCase()) throw new Error(`claim tx target ${tx.to} is not the claim ledger`);
      if (!CLAIM_SELECTORS.has(data.slice(0, 10))) throw new Error(`claim tx selector ${data.slice(0, 10)} is not a collectFees-family call`);
      if (tx.value != null && String(tx.value) !== "0") throw new Error("claim tx carries nonzero value");
      // Simulate from the treasury (the ledger pays msg.sender).
      await p.call({ account: TREASURY, to: tx.to, data: tx.data, value: 0n });
      if (DRY_RUN) { log("claim", "simulated OK (dry run — not broadcasting)"); continue; }
      const hash = await w.sendTransaction({ to: tx.to, data: tx.data, gas: tx.gas });
      const rc = await p.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (rc.status !== "success") throw new Error(`claim tx reverted: ${hash}`);
      log("claim", `claimed in tx ${hash} (block ${rc.blockNumber})`);
    }
  } else {
    log("claim", "nothing claimable — no-op");
  }

  // ── 2. SWAP ANTc → POD ─────────────────────────────────────────────
  let antcBal = await p.readContract({ address: ANTC, abi: ERC20, functionName: "balanceOf", args: [TREASURY] });
  log("swap", `treasury ANTc balance: ${formatUnits(antcBal, 8)}`);
  if (antcBal >= MIN_SWAP_ANTC) {
    const info: any = await lc.launchInfo(POD);
    const c0 = info.tokenIsCurrency0 ? POD : ANTC;
    const c1 = info.tokenIsCurrency0 ? ANTC : POD;
    let poolKey: any = null;
    for (const [f, ts] of [[8388608, 200], [0, 200], [10000, 200], [3000, 60], [500, 10], [100, 1]] as const) {
      const id = keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [c0, c1, f, ts, HOOK]));
      if (id.toLowerCase() === String(info.poolId).toLowerCase()) { poolKey = { currency0: c0, currency1: c1, fee: f, tickSpacing: ts, hooks: HOOK }; break; }
    }
    if (!poolKey) throw new Error("could not derive the POD pool key from launchInfo — refusing to swap");
    // ANTc in, POD out: POD is currency0 (launchInfo), so ANTc is
    // currency1 and the direction is oneForZero (zeroForOne = false).
    const zeroForOne = info.tokenIsCurrency0 ? false : true;
    const swapArgs = [poolKey, zeroForOne, antcBal, 0n, TREASURY, "0xba7c4a7c"] as const;
    // The settler pulls ANTc via transferFrom, so the quote simulation
    // only succeeds once it holds an allowance. Live runs therefore
    // approve FIRST (exact amount; the approve call itself is simulated
    // before broadcast), then simulate the swap, then broadcast it —
    // the swap is never sent unsimulated. Dry runs cannot approve, so
    // they quote through an eth_call state override of the allowance
    // slot instead (slots 0..20 probed; purely local, nothing sent).
    const allowance = await p.readContract({ address: ANTC, abi: ERC20, functionName: "allowance", args: [TREASURY, SETTLER] });
    if (allowance < antcBal && !DRY_RUN) {
      await p.simulateContract({ address: ANTC, abi: ERC20, functionName: "approve", args: [SETTLER, antcBal], account: TREASURY });
      const ah = await w.writeContract({ address: ANTC, abi: ERC20, functionName: "approve", args: [SETTLER, antcBal] });
      const arc = await p.waitForTransactionReceipt({ hash: ah, timeout: 180_000 });
      if (arc.status !== "success") throw new Error(`ANTc approve reverted: ${ah}`);
      log("swap", `approved settler for ${formatUnits(antcBal, 8)} ANTc (tx ${ah})`);
    }
    let expectedOut: bigint | null = null;
    if (!DRY_RUN || allowance >= antcBal) {
      const sim = await p.simulateContract({
        address: SETTLER, abi: SETTLER_ABI, functionName: "swapExactInput",
        args: [...swapArgs], account: TREASURY,
      });
      expectedOut = sim.result as bigint;
    } else {
      for (let slot = 0; slot <= 20 && expectedOut === null; slot++) {
        const inner = keccak256(encodeAbiParameters(parseAbiParameters("address,uint256"), [TREASURY, BigInt(slot)]));
        const outer = keccak256(encodeAbiParameters(parseAbiParameters("address,bytes32"), [SETTLER, inner]));
        try {
          const sim = await p.simulateContract({
            address: SETTLER, abi: SETTLER_ABI, functionName: "swapExactInput",
            args: [...swapArgs], account: TREASURY,
            stateOverride: [{ address: ANTC, stateDiff: [{ slot: outer, value: `0x${(2n ** 256n - 1n).toString(16).padStart(64, "0")}` as `0x${string}` }] }],
          } as any);
          expectedOut = sim.result as bigint;
        } catch { /* try the next slot */ }
      }
      if (expectedOut === null) log("swap", "dry-run quote unavailable (allowance override not found) — live run approves, then simulates");
    }
    if (expectedOut !== null) {
      log("swap", `simulated: ${formatUnits(antcBal, 8)} ANTc → ${formatUnits(expectedOut, 18)} POD`);
    }
    if (!DRY_RUN) {
      if (expectedOut === null) throw new Error("swap simulation failed in live mode — refusing to broadcast unsimulated");
      const minOut = (expectedOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      log("swap", `minOut bound: ${formatUnits(minOut, 18)} POD (${SLIPPAGE_BPS} bps under the simulation)`);
      const podBefore = await p.readContract({ address: POD, abi: ERC20, functionName: "balanceOf", args: [TREASURY] });
      const hash = await w.writeContract({
        address: SETTLER, abi: SETTLER_ABI, functionName: "swapExactInput",
        args: [poolKey, zeroForOne, antcBal, minOut, TREASURY, "0xba7c4a7c"],
      });
      const rc = await p.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (rc.status !== "success") throw new Error(`swap tx reverted: ${hash}`);
      const podAfter = await p.readContract({ address: POD, abi: ERC20, functionName: "balanceOf", args: [TREASURY] });
      const got = podAfter - podBefore;
      if (got < minOut) throw new Error(`swap settled below minOut: got ${got}, minOut ${minOut} (tx ${hash})`);
      log("swap", `swapped in tx ${hash}: received ${formatUnits(got, 18)} POD`);
    } else if (expectedOut !== null) {
      log("swap", "quote OK (dry run — not broadcasting)");
    }
  } else {
    log("swap", `ANTc balance below the ${formatUnits(MIN_SWAP_ANTC, 8)} dust floor — no-op`);
  }

  // ── 3. TOP UP the ShipRewards pool ─────────────────────────────────
  const podBal = DRY_RUN ? 0n : await p.readContract({ address: POD, abi: ERC20, functionName: "balanceOf", args: [TREASURY] });
  if (DRY_RUN) { log("topup", "dry run — skipping deposit readback"); }
  else if (podBal > 0n) {
    const hash = await w.writeContract({ address: POD, abi: ERC20, functionName: "transfer", args: [SHIP_REWARDS, podBal] });
    const rc = await p.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== "success") throw new Error(`pool deposit reverted: ${hash}`);
    log("topup", `deposited ${formatUnits(podBal, 18)} POD into ShipRewards (tx ${hash})`);
  } else {
    log("topup", "treasury holds no POD — no-op");
  }

  const poolBal = await p.readContract({ address: SHIP_REWARDS, abi: SHIP_ABI, functionName: "rewardBalance" });
  antcBal = await p.readContract({ address: ANTC, abi: ERC20, functionName: "balanceOf", args: [TREASURY] });
  log("done", `pool POD balance: ${formatUnits(poolBal, 18)} POD; treasury ANTc left: ${formatUnits(antcBal, 8)}`);
}

main().catch((err) => {
  console.error("[treasury-recycle] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
