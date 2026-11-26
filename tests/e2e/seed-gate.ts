/**
 * TEST-ONLY seed for the launch-gate driver (run-launch-gate.sh).
 * seed.ts already links @testauthor -> author wallet. This adds:
 *   - @testauthor -> recipient wallet link (the launcher wallet: gate
 *     check (c) requires the launch wallet linked to the login), and
 *   - 100 fresh PTK minted to the recipient (deploy.ts locks its whole
 *     1,000 PTK balance; prepare-lock needs a spendable balance).
 * MockERC20.mint is permissionless (testnet-only token).
 */
import * as fs from "fs";
import * as path from "path";
import { createWalletClient, defineChain, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addLinkedWallet } from "../../src/lib/devWallets";

// The E2E Hardhat node runs chainId 8453 (hardhat.local.config.ts), NOT
// viem's stock `hardhat` chain (31337) — define the local chain explicitly.
const localBase = defineChain({
  id: 8453,
  name: "Local Base (E2E)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));

  const wallets = await addLinkedWallet("testauthor", state.recipient, "signed");
  console.log("linked wallets for @testauthor:", JSON.stringify(wallets));

  // Gregory exception fixture (Codex round-2): the login "gregory"
  // linked to Gregory's real fee-recipient wallet — prepare-launch
  // may return that raw wallet ONLY for this identity (the platform's
  // own launch). Test-only link record; no key for that wallet exists
  // here and nothing is ever signed with it.
  const gregoryWallets = await addLinkedWallet(
    "gregory",
    "0x374d91a5674fa7cf86e725093b5848b97e1e13b4",
    "signed",
  );
  console.log("linked wallets for @gregory:", JSON.stringify(gregoryWallets));

  // Hardhat well-known account #0 (deployer) — public, test-only.
  const account = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const client = createWalletClient({ account, chain: localBase, transport: http("http://127.0.0.1:8545") });
  const hash = await client.writeContract({
    address: state.ptk as Address,
    abi: parseAbi(["function mint(address to, uint256 amount) external"]),
    functionName: "mint",
    args: [state.recipient as Address, 100n * 10n ** 18n],
  });
  console.log("minted 100 PTK -> recipient, tx:", hash);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
