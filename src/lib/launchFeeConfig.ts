/**
 * Platform launch fee split — Proof of Dev × Bankr launch-SDK.
 *
 * Gregory's locked decision (2026-11-25): every token launched through
 * the Proof of Dev platform carries exactly TWO fee recipients on the
 * CREATOR share of the launch:
 *
 *   25% (2500 bps of the creator share) → the platform REWARD TREASURY
 *        wallet. This wallet funds ShipRewards: its claimed quote fees
 *        are recycled — claimed WETH buys the platform reward token
 *        (via PodSettler) and tops up the ShipRewards pool, which pays
 *        out per counted merge. That is the "trickle": fees from every
 *        platform launch flow back out to the wallets that ship code
 *        through Proof of Dev.
 *   75% (7500 bps of the creator share) → Gregory's wallet. He claims
 *        his own share via the SDK's buildClaim like any other fee
 *        recipient (claims are beneficiary-signed).
 *
 * Scope of the percentages — read carefully: the 25/75 split applies to
 * the creator fee slice ONLY. On Bankr v4 pads the total trading fee is
 * routed by the pad FIRST (Bankr's cut, auto-LP, holder share, etc. —
 * on the tested pad defaults roughly 47.5% of each fee went to
 * auto-LP/holders before the creator split). 25/75 is NOT a split of
 * the whole trading fee.
 *
 * The reward treasury must be a claim-capable WALLET (an EOA or a
 * wallet whose key can sign): fee claims are beneficiary-signed by
 * design, so the ShipRewards contract itself can never be the fee
 * recipient — it cannot originate a claim transaction.
 *
 * LAUNCHER SHARE / FEE-LOCK VAULT (Gregory's decided rule, 2026-11-25):
 * the 7500-bps second share is the LAUNCHER share. On the platform's
 * own launch that launcher is Gregory, paid to his wallet above. On a
 * launch prepared for another launcher through the platform
 * (POST /api/launch/prepare-launch), the launcher share must NOT go
 * to the launcher's raw wallet — fees must never arrive liquid — so
 * buildPlatformLaunchInput takes `launcherFeeVault`: the project's
 * FeeLockVault (contracts/FeeLockVault.sol), a claim-capable contract
 * whose only outbound path is locking into FeeStreamEscrow. The
 * split's shape (2500/7500, exactly two recipients) is identical in
 * both cases; assertPlatformFeeSplit validates against whichever
 * launcher-share recipient the launch actually names.
 *
 * OPEN ITEM: no dedicated reward treasury wallet has been designated
 * yet. The address comes from PLATFORM_REWARD_TREASURY_WALLET (env);
 * while it is unset, buildPlatformLaunchInput() throws — a platform
 * launch must never silently fall back to a single-recipient or
 * wrong-recipient fee config.
 *
 * Vesting: platform launches set Bankr time-vesting EXPLICITLY to
 * { bps: 0 }. Binding lesson from the 2026-11-25 PODX test (report §2):
 * OMITTING the vesting field does not mean off — the SDK silently
 * defaults to a 15% Bankr time-vest (30d cliff / 365d). Push-based
 * unlocking on this platform is GitEscrow's job, not Bankr's calendar.
 */

import { env } from "./env";

export type Address = `0x${string}`;

/** Gregory's wallet — the 75% fee recipient on every platform launch. */
export const GREGORY_FEE_RECIPIENT_WALLET: Address =
  "0x374d91a5674fa7cf86e725093b5848b97e1e13b4";

/** Share of the CREATOR fee slice routed to the reward treasury. */
export const REWARD_TREASURY_SHARE_BPS = 2500;
/** Share of the CREATOR fee slice routed to Gregory's wallet. */
export const GREGORY_SHARE_BPS = 7500;
/** The 7500-bps share is the LAUNCHER share — Gregory's wallet when he
 *  is the launcher, the project's FeeLockVault for any other launcher. */
export const LAUNCHER_SHARE_BPS = GREGORY_SHARE_BPS;

/**
 * The configured reward treasury wallet, or null while none has been
 * designated (the open item — see header). Never a test address and
 * never Gregory's wallet: both are rejected by the split assertion.
 */
export const PLATFORM_REWARD_TREASURY_WALLET: Address | null =
  normalizeAddress(env.PLATFORM_REWARD_TREASURY_WALLET);

export interface LaunchFeeRecipient {
  recipient: Address;
  shareBps: number;
}

/** The Bankr launch-SDK vesting field for platform launches: explicitly OFF. */
export const PLATFORM_LAUNCH_VESTING = { bps: 0 } as const;

function normalizeAddress(raw: string | undefined | null): Address | null {
  const v = (raw ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(v) ? (v as Address) : null;
}

/**
 * The two platform fee recipients for a launch, in template order:
 * [reward treasury 2500, Gregory 7500]. Throws if the treasury wallet
 * has not been designated/configured — fail closed, never substitute.
 */
export function platformFeeRecipients(
  rewardTreasuryWallet: Address | null = PLATFORM_REWARD_TREASURY_WALLET,
  launcherShareRecipient: Address = GREGORY_FEE_RECIPIENT_WALLET,
): LaunchFeeRecipient[] {
  if (!rewardTreasuryWallet) {
    throw new Error(
      "PLATFORM_REWARD_TREASURY_WALLET is not configured: the dedicated " +
        "platform reward treasury wallet has not been designated yet, so a " +
        "platform launch input cannot be built (25/75 fee split, " +
        "src/lib/launchFeeConfig.ts).",
    );
  }
  const recipients: LaunchFeeRecipient[] = [
    { recipient: rewardTreasuryWallet, shareBps: REWARD_TREASURY_SHARE_BPS },
    { recipient: launcherShareRecipient, shareBps: LAUNCHER_SHARE_BPS },
  ];
  assertPlatformFeeSplit(recipients, launcherShareRecipient);
  return recipients;
}

/**
 * Invariants of the locked split: exactly two recipients, 2500/7500,
 * sum 10000, distinct wallets. The second (launcher-share) recipient
 * must equal `launcherShareRecipient` — Gregory's wallet by default
 * (the platform's own launch), or the project's FeeLockVault when the
 * launch is prepared for another launcher (fees never arrive liquid).
 */
export function assertPlatformFeeSplit(
  recipients: LaunchFeeRecipient[],
  launcherShareRecipient: Address = GREGORY_FEE_RECIPIENT_WALLET,
): void {
  if (recipients.length !== 2) {
    throw new Error(`platform fee split must have exactly 2 recipients, got ${recipients.length}`);
  }
  const [treasury, launcherShare] = recipients as [LaunchFeeRecipient, LaunchFeeRecipient];
  if (treasury.shareBps !== REWARD_TREASURY_SHARE_BPS) {
    throw new Error(`reward treasury share must be ${REWARD_TREASURY_SHARE_BPS} bps, got ${treasury.shareBps}`);
  }
  if (launcherShare.shareBps !== LAUNCHER_SHARE_BPS) {
    throw new Error(`launcher share must be ${LAUNCHER_SHARE_BPS} bps, got ${launcherShare.shareBps}`);
  }
  const sum = recipients.reduce((acc, r) => acc + r.shareBps, 0);
  if (sum !== 10_000) {
    throw new Error(`platform fee shares must sum to 10000 bps, got ${sum}`);
  }
  if (launcherShare.recipient.toLowerCase() !== launcherShareRecipient.toLowerCase()) {
    throw new Error(
      launcherShareRecipient.toLowerCase() === GREGORY_FEE_RECIPIENT_WALLET.toLowerCase()
        ? "second fee recipient must be Gregory's wallet"
        : "second fee recipient must be the project's fee-lock vault",
    );
  }
  if (treasury.recipient.toLowerCase() === launcherShare.recipient.toLowerCase()) {
    throw new Error(
      launcherShareRecipient.toLowerCase() === GREGORY_FEE_RECIPIENT_WALLET.toLowerCase()
        ? "reward treasury wallet must differ from Gregory's wallet"
        : "reward treasury wallet must differ from the launcher-share recipient",
    );
  }
}

/**
 * Apply the platform template to a Bankr launch-SDK input: returns a
 * copy of `base` with the locked fee split and vesting explicitly off.
 * `launcher` is the vesting recipient of record for the (zero) vest —
 * the SDK's vesting shape is { bps, recipient }; with bps 0 nothing
 * vests on Bankr's calendar regardless of recipient.
 */
export function buildPlatformLaunchInput<T extends Record<string, unknown>>(
  base: T,
  opts: {
    launcher: Address;
    rewardTreasuryWallet?: Address | null;
    /**
     * The project's FeeLockVault — REQUIRED when preparing a launch
     * for a launcher other than Gregory: the launcher share (7500 bps)
     * is paid to the vault so fees auto-lock instead of arriving
     * liquid. Omit only for the platform's own launch (Gregory is the
     * launcher; his share goes to his wallet).
     */
    launcherFeeVault?: Address;
  },
): T & {
  feeRecipients: LaunchFeeRecipient[];
  vesting: { bps: 0; recipient: Address };
} {
  const launcherShareRecipient = opts.launcherFeeVault ?? GREGORY_FEE_RECIPIENT_WALLET;
  return {
    ...base,
    feeRecipients: platformFeeRecipients(
      opts.rewardTreasuryWallet === undefined
        ? PLATFORM_REWARD_TREASURY_WALLET
        : opts.rewardTreasuryWallet,
      launcherShareRecipient,
    ),
    vesting: { bps: PLATFORM_LAUNCH_VESTING.bps, recipient: opts.launcher },
  };
}
