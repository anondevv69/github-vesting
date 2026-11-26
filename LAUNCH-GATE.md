# Launch Gate — GitHub App verification before any launch/deploy

**Rule (Gregory, 2026-11-25):** anyone deploying on the Proof of Dev
platform, or through an agent (skill / MCP path), must pass GitHub App
verification FIRST — and only then deploy. An agent's self-assertion is
not verification; the server-side check is the only one that counts.

**Scope correction (Codex review, 2026-11-25 — read this before
quoting the rule):** three different things are easy to conflate, and
earlier drafts of this note conflated them:

- **(a) Ordinary vesting lock** — the web-wizard flow: a user locks
  their own ERC-20 into GitEscrow for a repo and registers the grant
  with **no verification token**. This works today, is not a launch,
  and carries no launch recognition.
- **(b) Platform launch** — an SDK token launch executed through
  Proof of Dev surfaces. **The launch-prep surface now exists**
  (built 2026-11-25, follow-up pass): `POST /api/launch/prepare-launch`
  (MCP `prepare_launch`) builds the Bankr SDK launch input via
  `buildPlatformLaunchInput()` and REQUIRES a valid verification
  token — verification is now mandatory before a platform launch at
  the one launch surface that exists. The surface PREPARES an input
  only; signing/broadcasting a launch remains the launcher's step.
- **(c) Verified-launch recognition** — what the gate actually
  enforces today: lock-preparation endpoints require the token, and
  grant registration stamps `launchVerified` + writes the launcher
  enrolment only when a valid token is presented (and, per the
  ordering check below, only when the lock did not predate it).

So the precise statement is: **verification is mandatory before
agent-path lock preparation, before verified-launch recognition,
and — since the follow-up pass built the launch-prep surface —
before a platform launch is prepared.** A launch executed entirely
outside Proof of Dev surfaces still cannot be gated (the SDK is
permissionless); it receives no recognition.

**Status:** built and E2E-proven locally (2026-11-25). NOT deployed —
the backend redeploy is Gregory's step (the live backend has previously
run with GitHub secrets unset, `configured:false`; the gate is built
against the same fixture/mock pattern as the existing E2E suites and
needs no new secrets: it reuses `SESSION_SECRET` for token signing and
the existing GitHub App credentials for the checks).

## What was built, and where

| Piece | File |
|---|---|
| Core gate: 3 checks, token issue/validate, launcher enrolment | `src/lib/launchGate.ts` |
| Verify endpoint + enrolment read | `src/api/launchVerify.ts` (`POST /api/launch/verify-github`, `GET /api/launch/enrollment`) |
| Routes | `src/index.ts` |
| Gate enforcement on prepare / lock / confirm-lock | `src/api/agentLock.ts` (`requireLaunchGate`) |
| Recognition seam at grant registration (+ enrolment write) | `src/api/register.ts` |
| Ownership/admin evidence (collaborator permission) | `src/github/githubApp.ts` (`getCollaboratorPermission`) |
| Token/enrolment Redis keys, grant flags | `src/lib/redis.ts` (`launchVerified`, `launchVerifiedLogin`, `launcherRewardEnrolled` on `GrantRecord`) |
| MCP tools incl. `verify_github` and `prepare_launch`; `prepare_lock` requires `verificationToken` | `src/lib/mcpTools.ts` (13 tools; both transports share this source) |
| Skills: Step 0 verification | `skills/claude-vesting/SKILL.md`, `skills/bankr-vesting/SKILL.md` (the Claude skill is also the backend-served `/claude-skill.md`) |
| Agent protocol doc | `docs/agent.md` (served at `/agent.md`) |
| Tests | `tests/e2e/run-launch-gate.sh` (+ `seed-gate.ts`, fixture extensions in `github-fixture.js`) |

## The three checks (all server-side, GitHub App credentials)

For `{githubLogin, repo, wallet, chain}`:

1. **Installed** — installation lookup for the repo
   (`GET /repos/{owner}/{repo}/installation`) must resolve, and the
   installation must actually access the repo (`validateRepoAccess`).
2. **Owner or admin** — the repo's owner login matches the requesting
   login, OR the login's collaborator permission on the repo is
   `admin`. Fail closed on no answer.
3. **Wallet linked** — the wallet is in the login's link-wallet store
   (`isWalletLinked`). Links are only created by signature or
   magic-link proofs, so this binds login ↔ wallet with evidence.

Any failure → 403 with a specific `code`
(`LAUNCH_APP_NOT_INSTALLED`, `LAUNCH_APP_NO_ACCESS`,
`LAUNCH_NOT_OWNER_OR_ADMIN`, `LAUNCH_WALLET_NOT_LINKED`) and **no
token is issued**.

## The verification token

On success: an HMAC-SHA256 token (keyed by `SESSION_SECRET`, the
codebase's existing session secret) wrapping claims
`{v, githubLogin, repo, wallet, chainId, installationId, iat, exp, nonce}`
with a **15-minute** TTL. The nonce is stored in Redis at issuance.
Validation (on every gated call) checks, in order: signature → expiry
→ exact repo binding → exact wallet binding → chain binding → the
stored issuance record. A token minted for repo A / wallet X / chain C
cannot be replayed for anything else; a correctly-signed token with no
issuance record is refused.

## Where the gate bites

- `POST /api/agent/prepare-lock`, `POST /api/agent/lock`,
  `POST /api/agent/confirm-lock` — all require a valid token for the
  exact repo + wallet + chain (body `verificationToken` or
  `x-launch-verification` header). These are **lock-preparation**
  endpoints (the agent/MCP surface; `prepare_lock` forwards to
  `/api/agent/lock`). They prepare and confirm LOCKS — they do not
  build or execute SDK launches, and no endpoint does today.
- `POST /api/vesting/register` — a presented token is re-validated;
  an invalid one refuses registration. Grants registered with a valid
  token are stamped `launchVerified` / `launchVerifiedLogin`
  (subject to the ordering check below).
- The web wizard's legacy register path (no token) still works for
  ordinary vesting locks (definition (a) above), but such grants are
  **not** launch-verified and carry no launch recognition (below).

## Token reuse semantics (defined, Codex review 2026-11-25)

- **Reuse within the TTL is INTENTIONAL.** One token may be presented
  across prepare → lock → confirm → register for the **same
  repo + wallet + chain** any number of times inside its 15-minute
  TTL. The flow is multi-step by design; single-use tokens would
  break it. Cross-repo, cross-wallet, and cross-chain presentation
  are all refused (tested, including the wrong-chain case).
- **Ordering check (implemented in `register.ts`):** a stamp asserts
  "verified FIRST, then locked". When the registration transaction
  is the lock tx itself (it carries a `Locked` event, so its block
  timestamp is known) and that timestamp is **earlier than the
  token's `iat`**, registration proceeds as an ordinary grant but the
  stamp and enrolment are **withheld** (response carries
  `launchVerification: {stamped: false, note}`). Tested: a lock
  predating its token registers unstamped with no enrolment; a lock
  after its token stamps normally.
- **Ordering is FAIL-CLOSED (follow-up pass, 2026-11-25):** when
  the registration tx carries no `Locked` event (e.g. a mint or
  approve tx hash is submitted instead), no lock timestamp can be
  read from it and ordering is unprovable — the stamp and enrolment
  are now WITHHELD in that case too (response carries
  `launchVerification: {stamped: false, code:
  "LAUNCH_ORDERING_UNPROVABLE"}`), exactly as for a provably
  predating lock (`LAUNCH_ORDERING_PREDATES_VERIFICATION`). A stamp
  is issued only when a lock timestamp >= the token's `iat` is
  proven from the registration tx itself. Tested both ways in
  `run-launch-gate.sh` (steps 18, 23, 24).

## Recognition rule

A grant with no verification stamp gets **no** launch recognition:
it does not appear on the verified-launch listing
(`GET /api/launch/projects`, which lists only `launchVerified`
grants), it is flagged `launchVerified: false` on the general
listing (`GET /api/vesting/explore`), and it has **no ShipRewards
launcher enrolment**. Its pushes still count toward its own ordinary
vesting schedule — an ordinary lock is a real lock — but that
counting is vesting, not launch recognition, and it never creates
launcher eligibility. These exclusions are enforced in code and
proven by `tests/e2e/run-launch-exclusions.sh` (see report §13):
the enrolment exclusion existed already; the verified-launch
listing and the explore flag were built for this correction.

## Dual reward — verified launchers earn while they unlock (§8B)

A launcher who passed the gate and whose grant registers with the
valid token is **automatically enrolled for ShipRewards** at
registration (`recordLauncherRewardEnrollment` in
`src/lib/launchGate.ts`, called from `src/api/register.ts`): the
enrolment record ties `{repo, launcher wallet, githubLogin,
verificationNonce (token id), chainId}` and the grant is stamped
`launcherRewardEnrolled: true`. Read it at
`GET /api/launch/enrollment?repo=&wallet=`.

What enrolment means — stated precisely (corrected, Codex review
2026-11-25): enrolment is an **eligibility record**, not a payout.
The ShipRewards payout path that exists today (webhook → verifier →
`ShipRewards.pay`, flat per counted merge, keyed by merge hash, one
payment per merge hash) pays the **PR author** of each counted
merge — on grant repos and grant-less repos alike. That per-merge
**author** reward is separate from the launcher's trading fees, and
it already works.

**Decided launcher fee rule (Gregory, 2026-11-25):** a launcher's
trading fees must not arrive liquid — their fee share is
**auto-locked** and unlocks by counted pushes, like their supply
lock. Stated in three parts so it is never misstated:

- **(a) Today's truth:** SDK fee recipients claim **liquid WETH**
  via `buildClaim`; nothing auto-locks fees yet.
- **(b) The decided rule:** on a Proof of Dev launch the launcher's
  fee recipient is a **per-project fee-lock vault** (a claim-capable
  smart account; not the raw wallet, and not the escrow contract,
  which cannot claim). A keeper cycle claims accrued fees and locks
  them into a **fee-stream grant** whose tranches unlock over
  subsequent counted pushes. Denomination is still open: lock the
  claimed WETH as WETH, or swap it to the project token via
  PodSettler before locking.
- **(c) Status:** **BUILT locally** in the follow-up pass
  (2026-11-25): `contracts/FeeLockVault.sol` (claim-capable vault;
  its only outbound path is into the escrow),
  `contracts/FeeStreamEscrow.sol` (fee-stream grants; tranches vest
  pro-rata over the counted pushes after their lock),
  `scripts/fee-lock-keeper.ts` (permissionless claim → lock cycle),
  and the oracle release step in `src/oracle/feeLock.ts` hooked into
  the counted-push path. The launch template names the vault as the
  launcher-share recipient, and prepare-launch refuses to prepare a
  platform launch without one. Proven by
  `tests/e2e/run-fee-lock.sh` — **31/31 PASS**. NOT deployed, and no
  production launch has used it; the denomination decision in (b)
  is still open (the built default locks the claimed WETH as-is).

So no doc may promise that a launcher receives the platform reward
token for merges authored by other people: the author reward goes
to the author, and the launcher's own fee benefit is the fee-lock
stream in (b), once built. **Reward amounts are unchanged** — the
flat base author-reward schedule is still Gregory's open decision
(§8B.2).

**Funding loop (DESIGNED, not operating):** the design is for
launchpad trading fees (the Bankr SDK fee-recipient split on the
Proof of Dev pad) to refill the ShipRewards pool, so launcher
activity funds the rewards. It is **not operating today**: the
reward treasury wallet is undesignated and the production reward
token does not exist yet (ShipRewards pays a mock token in tests).
The exact split is locked in the next section.

## Fee split — 25% reward treasury / 75% Gregory (locked 2026-11-25)

Every token launched through the Proof of Dev platform carries
exactly **two fee recipients on the creator share**, encoded in
`src/lib/launchFeeConfig.ts` (`platformFeeRecipients()` /
`buildPlatformLaunchInput()`, shares as `shareBps`):

| Recipient | Share of creator slice | Purpose |
|---|---|---|
| Platform reward treasury wallet (`PLATFORM_REWARD_TREASURY_WALLET`) | **2500 bps (25%)** | Funds ShipRewards (below) |
| Gregory's wallet `0x374d91a5674fa7cf86e725093b5848b97e1e13b4` | **7500 bps (75%)** | Gregory's platform fee income |

**Scope, stated precisely:** the 25/75 applies to the **creator fee
slice the launchpad controls** — what remains of each trade's fee
after the Bankr v4 pad's built-in routing (Bankr's cut, auto-LP,
holder share) comes off the total fee first. On the tested pad
defaults that routing took roughly 47.5% of each fee before the
creator split. It is **not** 25/75 of the whole trading fee, and no
doc or UI may present it that way.

**The claim-and-recycle loop (the "trickle") — DESIGNED, not
operating (the treasury wallet and the production reward token are
still pending; nothing recycles today):**
1. Trading fees accrue to the two recipients, claimable on-chain.
2. The reward treasury **claims its 25%** — claims are
   beneficiary-signed by design, so the treasury is a claim-capable
   **wallet** whose key can sign a claim. The ShipRewards contract
   itself can never be the fee recipient: a contract that cannot
   originate transactions could never claim.
3. Claimed WETH buys the platform reward token via **PodSettler**
   (the purpose-built settler proven in the report, §9).
4. The bought reward tokens **top up the ShipRewards pool**, which
   pays out per counted merge — so fees from platform launches
   trickle back out to the wallets that ship code through Proof of
   Dev, including verified launchers themselves (§8B dual reward).
5. Gregory's 75% is his directly: it accrues to his wallet as fee
   recipient and he claims his own share via the SDK's `buildClaim`
   like any other recipient — no platform step touches it.

**Vesting in the same template:** platform launch inputs set Bankr
time-vesting **explicitly** to `{ bps: 0 }`. Omitting the field is
not "off" — the SDK silently defaults to a 15% time-vest (report
§2). Push-based unlocking is GitEscrow's job.

**Open item (the only one):** no dedicated reward treasury wallet
has been designated yet. The address is config
(`PLATFORM_REWARD_TREASURY_WALLET`); while it is unset,
`buildPlatformLaunchInput()` **throws** rather than substituting any
address — a platform launch can never silently ship with a
single-recipient or wrong-recipient fee config. No test compartment
address is used as a stand-in anywhere in the config.

**Test:** `tests/launch-fee-config-test.ts` —
`npx tsx tests/launch-fee-config-test.ts` → **9/9 PASS** (extended in
the follow-up pass with the fee-lock-vault wiring: the launcher share
can be the project's vault, validated against the vault and never
against Gregory's wallet in that position): constants
2500/7500 sum to 10000; the built launch input carries exactly two
feeRecipients (treasury 2500, Gregory's exact wallet 7500) and
`vesting.bps === 0` present (not omitted); missing treasury →
refused; treasury = Gregory's wallet → refused; tampered splits →
rejected by `assertPlatformFeeSplit`.

**Launcher flow (target flow; the launch step's surface is not
built yet — see the scope correction at the top):** Step 0 verify →
launch → supply auto-lock → ship → unlock supply at milestones;
counted merges pay the platform reward token to the **PR author**
(the separate, already-working author reward); the launcher's
trading-fee share auto-locks into a fee-stream grant and unlocks by
counted pushes **once the fee-lock vault is built** (decided rule,
built locally in the follow-up pass — contracts/FeeLockVault.sol + FeeStreamEscrow, keeper, oracle step, 31/31 E2E; not deployed — while SDK launches outside the platform still claim liquid WETH).

## Test results (2026-11-25, local)

`tests/e2e/run-launch-gate.sh` — **42 PASS / 0 failures** (extended with the fail-closed unprovable-ordering case, step 24), covering:
verify refusals (not installed / not owner-or-admin / wallet not
linked, no token issued in each case); happy verify; prepare-lock
refusals (no token, repo mismatch, wallet mismatch, **chain
mismatch**, expired token, **correctly-signed token with no
issuance record**); happy prepare; intentional token reuse within
the TTL across prepare calls; confirm-lock refusal without a token;
register refusal on a garbage token; verified register (with a
post-verification lock tx) → grant stamped + enrolment record
present and tied to the login and token nonce; unverified register
→ grant exists but **no enrolment**; **ordering: a lock tx predating
its verification token registers unstamped, with no enrolment**.
Companion suites from the same correction (report §13):
`run-launch-exclusions.sh` **13/13** (unstamped grant excluded from
the verified-launch listing and enrolment, before and after a
counted push) and `run-concurrency.sh` **6/6** (concurrent duplicate
webhooks count exactly once).

Regression, all green the same day:

- `tests/e2e/run-rewards.sh` — **28 PASS / 0 failures** (unchanged
  baseline).
- `tests/e2e/run-attestation.sh` — **0 failures**.
- `tests/e2e/run-mcp-remote.sh` — **ALL PASS** (tools/list now 13,
  including `verify_github` and `prepare_launch`; stdio/remote parity holds).
- Follow-up pass suites: `tests/e2e/run-fee-lock.sh` — **31/31 PASS**
  (prepare-launch gate + split, vault outbound-path audit, the full
  claim → lock → counted-push release loop across two tranches);
  `tests/e2e/run-recount.sh` — **11/11 PASS** (equivalent recount from
  the recorded push log: recount total equals the webhook-counted
  total for a mixed history, and the rotated backup oracle releases
  exactly the recount-backed milestones).

## The honest boundary

The Bankr SDK is permissionless: a launch executed entirely outside
this platform, with a wallet talking straight to the SDK, **cannot be
stopped on-chain** by anything here. What the gate controls is
everything Proof of Dev *grants*: launch prep on our surfaces, grant
registration/recognition, push counting, ShipRewards eligibility, and
listing. An outside launch simply receives none of those.

**Future hard-gate option (noted, NOT built):** a platform
launch-helper contract that requires the signed verification
attestation (the token above, or an EIP-712 variant) before it will
call the SDK launch for a user — making verification a precondition
of the platform's on-chain launch route itself, not just of its API
surfaces. That is a contract build + audit decision for Gregory; the
API gate above is the enforced rule today.
