/**
 * Platform launch fee-split config test (unit / config-level, no chain).
 * Run: npx tsx tests/launch-fee-config-test.ts
 *
 * Proves Gregory's locked decision (2026-11-25) is what the launch
 * template actually builds:
 *  1. Exactly TWO fee recipients on the creator share: reward treasury
 *     2500 bps + Gregory 7500 bps, summing to 10000.
 *  2. Gregory's recipient is his exact wallet; the treasury recipient
 *     is the configured treasury wallet and never Gregory's wallet.
 *  3. Vesting is EXPLICITLY { bps: 0 } in the built input (omission
 *     silently defaults to a 15% Bankr time-vest — report §2).
 *  4. Fail-closed: with no treasury wallet designated/configured, the
 *     template refuses to build instead of substituting any address.
 *  5. The assertion helper rejects a tampered split.
 */
import assert from "node:assert";
import {
  GREGORY_FEE_RECIPIENT_WALLET,
  GREGORY_SHARE_BPS,
  REWARD_TREASURY_SHARE_BPS,
  assertPlatformFeeSplit,
  buildPlatformLaunchInput,
  platformFeeRecipients,
} from "../src/lib/launchFeeConfig";

// A throwaway stand-in used ONLY as the treasury argument in this test
// (proves plumbing + validation). It is not a designated treasury.
const TEST_TREASURY = "0x1111111111111111111111111111111111111111" as const;
const TEST_LAUNCHER = "0x2222222222222222222222222222222222222222" as const;

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  PASS ${name}`);
}

check("split constants are 2500 / 7500 and sum to 10000", () => {
  assert.equal(REWARD_TREASURY_SHARE_BPS, 2500);
  assert.equal(GREGORY_SHARE_BPS, 7500);
  assert.equal(REWARD_TREASURY_SHARE_BPS + GREGORY_SHARE_BPS, 10_000);
});

check("platformFeeRecipients returns exactly the locked two-recipient split", () => {
  const recipients = platformFeeRecipients(TEST_TREASURY);
  assert.equal(recipients.length, 2);
  assert.deepEqual(recipients[0], { recipient: TEST_TREASURY, shareBps: 2500 });
  assert.deepEqual(recipients[1], {
    recipient: GREGORY_FEE_RECIPIENT_WALLET,
    shareBps: 7500,
  });
  assert.equal(
    recipients[1]!.recipient,
    "0x374d91a5674fa7cf86e725093b5848b97e1e13b4",
  );
  assert.equal(
    recipients.reduce((acc, r) => acc + r.shareBps, 0),
    10_000,
  );
});

check("built launch input carries the split and vesting explicitly { bps: 0 }", () => {
  const input = buildPlatformLaunchInput(
    { name: "Template Probe", symbol: "TPX", launchpadId: 5n },
    { launcher: TEST_LAUNCHER, rewardTreasuryWallet: TEST_TREASURY },
  );
  assert.equal(input.feeRecipients.length, 2);
  assert.deepEqual(
    input.feeRecipients.map((r) => r.shareBps),
    [2500, 7500],
  );
  assert.ok("vesting" in input, "vesting field must be present, not omitted");
  assert.equal(input.vesting.bps, 0);
  assert.equal(input.vesting.recipient, TEST_LAUNCHER);
  // Base fields pass through untouched.
  assert.equal((input as { symbol: string }).symbol, "TPX");
});

check("fail-closed: no treasury designated → template refuses to build", () => {
  assert.throws(
    () => platformFeeRecipients(null),
    /PLATFORM_REWARD_TREASURY_WALLET is not configured/,
  );
  assert.throws(
    () =>
      buildPlatformLaunchInput(
        { name: "X" },
        { launcher: TEST_LAUNCHER, rewardTreasuryWallet: null },
      ),
    /not configured/,
  );
});

check("treasury can never be Gregory's wallet (no double-use)", () => {
  assert.throws(
    () => platformFeeRecipients(GREGORY_FEE_RECIPIENT_WALLET),
    /must differ from Gregory's wallet/,
  );
});

check("assertion rejects tampered splits", () => {
  assert.throws(() =>
    assertPlatformFeeSplit([
      { recipient: TEST_TREASURY, shareBps: 5000 },
      { recipient: GREGORY_FEE_RECIPIENT_WALLET, shareBps: 5000 },
    ]),
  );
  assert.throws(() =>
    assertPlatformFeeSplit([
      { recipient: TEST_TREASURY, shareBps: 2500 },
      { recipient: GREGORY_FEE_RECIPIENT_WALLET, shareBps: 7500 },
      { recipient: TEST_LAUNCHER, shareBps: 0 },
    ]),
  );
});

const TEST_VAULT = "0x3333333333333333333333333333333333333333" as const;

check("launcher share can be the project's fee-lock vault (fee-lock wiring)", () => {
  const input = buildPlatformLaunchInput(
    { name: "Vault Probe", symbol: "VPX" },
    { launcher: TEST_LAUNCHER, rewardTreasuryWallet: TEST_TREASURY, launcherFeeVault: TEST_VAULT },
  );
  assert.equal(input.feeRecipients.length, 2);
  assert.deepEqual(input.feeRecipients[0], { recipient: TEST_TREASURY, shareBps: 2500 });
  assert.deepEqual(input.feeRecipients[1], { recipient: TEST_VAULT, shareBps: 7500 });
  assert.equal(input.vesting.bps, 0);
});

check("assertion validates a vault split only against the vault, not Gregory", () => {
  const vaultSplit = [
    { recipient: TEST_TREASURY, shareBps: 2500 },
    { recipient: TEST_VAULT, shareBps: 7500 },
  ] as const;
  assertPlatformFeeSplit([...vaultSplit], TEST_VAULT); // passes against the vault
  assert.throws(() => assertPlatformFeeSplit([...vaultSplit])); // fails against default Gregory
  assert.throws(() =>
    assertPlatformFeeSplit(
      [
        { recipient: TEST_TREASURY, shareBps: 2500 },
        { recipient: GREGORY_FEE_RECIPIENT_WALLET, shareBps: 7500 },
      ],
      TEST_VAULT,
    ),
  ); // Gregory's wallet is NOT accepted where the vault belongs
});

check("treasury can never be the fee-lock vault either", () => {
  assert.throws(
    () => platformFeeRecipients(TEST_VAULT, TEST_VAULT),
    /must differ/,
  );
});

// Round-4: the REAL designated treasury. Gregory designated a
// dedicated treasury wallet (hidden_files/treasury-wallet.json,
// created 2026-11-25); with it configured, the fail-closed path
// lifts and the built input carries exactly that address in the
// 2500 position. Skipped (loudly) if the record is absent.
import * as fs from "node:fs";
import * as path from "node:path";
const treasuryRecordPath = path.join(__dirname, "..", "hidden_files", "treasury-wallet.json");
if (fs.existsSync(treasuryRecordPath)) {
  const record = JSON.parse(fs.readFileSync(treasuryRecordPath, "utf8")) as { address: string };
  check("designated treasury wallet lifts the fail-closed path (real address)", () => {
    const input = buildPlatformLaunchInput(
      { name: "Treasury Probe", symbol: "TRP" },
      { launcher: TEST_LAUNCHER, rewardTreasuryWallet: record.address as `0x${string}` },
    );
    assert.equal(input.feeRecipients.length, 2);
    assert.equal(input.feeRecipients[0]!.recipient.toLowerCase(), record.address.toLowerCase());
    assert.equal(input.feeRecipients[0]!.shareBps, 2500);
    assert.notEqual(
      input.feeRecipients[0]!.recipient.toLowerCase(),
      GREGORY_FEE_RECIPIENT_WALLET.toLowerCase(),
    );
  });
  console.log(`  (designated treasury on file: ${record.address})`);
} else {
  console.log("  SKIP designated-treasury check — hidden_files/treasury-wallet.json absent");
}

console.log(`\nlaunch-fee-config: ${passed} checks PASS`);
