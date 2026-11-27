---
name: claude-vesting
description: Proof of Dev — GitHub-gated token vesting (proofofdev.xyz). Lock any ERC-20 on Base so verified pushes and merged PRs release it on a milestone schedule, check vesting progress for a wallet or repo, link a GitHub account to a wallet, and earn the per-counted-merge ShipRewards payout as a PR author. Use when the user mentions Proof of Dev, proofofdev, github vesting, locking tokens against a repo, vesting progress / verified pushes / milestones, linking a wallet to GitHub, merge rewards, reporting a ship (attestation) or checking a ship report's state, or asks what a Claude Ship / /ship merge earned. Works entirely over the agent API at https://api.proofofdev.xyz — no website required.
tags: [github, vesting, claude, base, defi, proofofdev, rewards]
version: 3
---

# Proof of Dev — Claude skill (GitHub-gated token vesting)

## What this system is

**Proof of Dev** (proofofdev.xyz) turns shipped code into token releases:

1. **Vesting (unlock):** anyone can lock an ERC-20 (Base; the API also supports
   `robinhood` and `base-sepolia` via a `chain` field) into the `GitEscrow`
   contract against a GitHub repo, with a schedule like "1,000 tokens over
   10 counted pushes, release every 2." A server-side verifier watches the
   repo's pushes; every counted push advances the counter, and at each
   milestone an oracle calls `GitEscrow.release()` — the tranche goes to the
   grant's recipient wallet, fixed on-chain at lock time.
2. **Merge rewards (ShipRewards):** on **every counted merged PR**, the PR
   *author* is additionally paid a flat reward in the platform reward token
   from a pre-funded `ShipRewards` pool. **No vesting grant is required:**
   any repo with the Proof of Dev GitHub App installed is verified with
   the same anti-gaming rules, and counted merges earn the reward whether
   or not anything is locked (a grant only adds the vesting *unlock* on
   top). The reward goes to the author's **most recently linked** wallet
   (the linked-wallet list is newest-first and the oracle pays the first
   entry) and is keyed by the merge commit hash, so a merge can never be
   paid twice. If the author has **no linked wallet**, the reward is not
   lost — it accrues as a pending reward and pays out automatically when
   they link one (see "Pending rewards" below). Rewards also require the
   server to be configured with a `ShipRewards` pool address and a
   non-zero per-merge amount; when either is unset, merges still count
   but pay (and accrue) no reward.

**API base URL:** `https://api.proofofdev.xyz`
**Canonical protocol:** before your first session with this API, fetch
`https://api.proofofdev.xyz/agent.md` — it is the source of truth for
endpoints and response shapes. This SKILL.md is the Claude-specific guide
(signing routes, hard rules, Ship tie-in); where the two disagree, the code
and `/agent.md` win.

**Install:** copy this folder (`skills/claude-vesting/`) into your skills
directory (e.g. `~/.claude/skills/claude-vesting/` for Claude Code) so the
skill triggers on the phrases in the description.

---

## READ FIRST — hard rules for every write (lock, launch, onboard)

These rules exist because the most common agent failure on this API is
calling a prepare endpoint with no verification token and reporting a
dead end. Do not be that agent.

1. **VERIFY IN THIS SESSION, BEFORE ANY PREPARE.** No
   `POST /api/agent/prepare-lock`, `POST /api/agent/lock`,
   `POST /api/agent/confirm-lock`, `POST /api/launch/onboard`, or
   `POST /api/launch/prepare-launch` call may be made unless you hold a
   `verificationToken` returned by `POST /api/launch/verify-github`
   **earlier in this same session**, bound to the exact
   `{githubLogin, repo, wallet, chain}` you are about to act on. A
   token from another session, another repo, another wallet, or
   another chain does not count. Tokens live ~15 minutes — if yours
   may have expired, verify again; verifying is free and instant.
2. **ON `LAUNCH_VERIFICATION_REQUIRED`, NEVER RETRY THE SAME CALL.**
   That error means rule 1 was broken (or the token lapsed). Go to
   Step 1 (verify) and run it, then diagnose any refusal by its
   specific `code` using the error table in Step 1. Resending the
   prepare/confirm call unchanged will fail identically.
3. **NEVER INVENT ENDPOINTS, FIELDS, OR VALUES.** Every call in the
   procedures below is given with its exact method, path, and JSON
   body. Use them verbatim. If a value the body needs is not known
   (the repo, the wallet, the login), ask the user — never guess,
   never substitute a similar-looking repo or an address from memory.
4. **AMOUNTS COME FROM LIVE READS, NEVER FROM MEMORY.** Before
   preparing any lock, read the wallet's current balance for the
   token (`GET /api/agent/fee-tokens`, wallet header) in this
   session. A fraction in the user's words ("half my POD") is
   computed from that live balance — see "Phrase handling" in the
   lock procedure.
5. **YOUR SELF-ASSERTION IS NOT VERIFICATION.** Only the server
   issuing a `verificationToken` counts. Never tell the user "we're
   verified" because the app looks installed or the user says so.

## Hard rules (read before any write)

- **NEVER ask the user for a private key or seed phrase** — in chat, in a
  form, anywhere. Signing always happens inside a wallet tool, never by
  pasting key material to you.
- **NEVER invent a wallet address.** Use only an address the user gave you,
  their connected wallet returned, or an API response contained. If you
  don't have the user's wallet address, ask for it (reads need one).
- **A lock moves real funds.** Before submitting any lock transaction,
  restate and get explicit confirmation of: token (address + symbol),
  amount, repo (`owner/repo`), chain, and schedule (total pushes +
  pushes per milestone). No confirmation, no submit.
- **Only sign what the API prepared.** Sign exactly the `transactions[]`
  returned by `POST /api/agent/lock`, in order. Check each item's `to`,
  `data`, `value`, and `chainId` (8453 = Base) against the response before
  signing; abort and report if anything looks off or unexpected.
- **Never fabricate status.** If the API is unreachable or errors, say so
  (see Failure handling). Do not guess push counts, balances, or tx state.

---

## Read flows (no auth — a wallet address is enough)

All reads accept `?wallet=0x…` or the `x-wallet-address: 0x…` header
(header preferred).

### Briefing — "my vesting / my locks / how are my locks doing?"

```bash
curl -s "https://api.proofofdev.xyz/api/agent/briefing?wallet=0xWALLET"
```

Returns `grantCount`, `grants[]` (each with `repoFullName`, `status`,
`streaming`, `chain`, `progress` — `verifiedPushCount`,
`totalPushesRequired`, `pushesUntilNextRelease` — `statusUrl`,
`lockTxUrl`), plus `replyText` and `links`.

### Grant list — "list my vesting locks in detail"

```bash
curl -s -H "x-wallet-address: 0xWALLET" \
  "https://api.proofofdev.xyz/api/agent/grants"
```

### Repo status — "how close is owner/repo to its next release?"

```bash
curl -s "https://api.proofofdev.xyz/api/agent/status?repo=owner/repo"
```

No wallet needed. This is the call to make after a merge to report what it
earned (see Claude Ship tie-in).

### Fee tokens — "what can I lock?"

```bash
curl -s -H "x-wallet-address: 0xWALLET" \
  "https://api.proofofdev.xyz/api/agent/fee-tokens"
```

Lists the wallet's ERC-20 holdings on the chain (`tokens[]` with `address`,
`symbol`, `balanceRaw`). Any ERC-20 can be locked — this list is a
convenience, not an allowlist. Never tell the user a token is "unsupported"
without trying `POST /api/agent/lock` first.

### How to summarize results for the user

Build your summary from the structured fields, not by pasting `replyText`
verbatim: per grant give repo, `verifiedPushCount/totalPushesRequired`,
pushes until next release, amount locked and per-milestone tranche, and the
`statusUrl` on its own line. If `grantCount` is 0, say there are no locks
for that wallet and offer the lock flow (or `GET /api/agent/setup-link?wallet=0x…`
for the web fallback).

---

## Step 1 — VERIFY (required before any lock, launch, or onboard)

**No lock preparation, launch preparation, onboarding, or grant
registration happens before this step passes in this session.** The
gate is a **server-side** GitHub App verification. Run it exactly like
this — all three body fields are required (`wallet` included; omitting
it returns `LAUNCH_VERIFY_BAD_INPUT`):

```bash
curl -s -X POST "https://api.proofofdev.xyz/api/launch/verify-github" \
  -H "content-type: application/json" \
  -d '{
    "githubLogin": "their-login",
    "repo": "owner/repo",
    "wallet": "0xWALLET",
    "chain": "base"
  }'
```

`chain` is optional and defaults to `"base"` (`"robinhood"` and
`"base-sepolia"` are the other accepted values) — but the token binds
to the chain you verify for, so verify for the chain you will act on.

The **server** (never you) checks all three, with the GitHub App's own
credentials: (a) the Proof of Dev GitHub App is **installed** on the
repo, (b) the GitHub login **owns the repo or is an admin** on it,
(c) the wallet is **linked** to that GitHub login. On success the
response is `{ ok: true, verified: true, verificationToken,
expiresAt, ... }`. **Save the `verificationToken`** — signed, valid
~15 minutes, bound to exactly that login + repo + wallet + chainId.
Present it as the body field `verificationToken` on every prepare and
confirm call that follows.

### Verify error table — diagnose by `code`, fix, re-verify

A refusal is never a dead end; each code has exactly one fix. Relay
the `code`/`error` to the user as-is while you apply the fix.

| `code` | Meaning | Your next action |
|---|---|---|
| `LAUNCH_VERIFY_BAD_INPUT` | A required field is missing or malformed. | Check the body: `githubLogin`, `repo` (`owner/name`), and `wallet` (`0x…`) must all be present. Fix and re-run. |
| `LAUNCH_APP_NOT_INSTALLED` | The Proof of Dev GitHub App is not installed on the repo (or cannot access it — also `LAUNCH_APP_NO_ACCESS`). | Give the user the install URL `https://github.com/apps/bankr-vesting/installations/new` and ask them to install the app and select this repo. Wait for them, then re-run verify. |
| `LAUNCH_NOT_OWNER_OR_ADMIN` | The login does not own the repo and is not an admin on it. | Ask the user which login owns/admins the repo; verify with that login instead. Do not proceed with a non-owner login. |
| `LAUNCH_WALLET_NOT_LINKED` | The wallet is not linked to that GitHub login. | Run the link step below, give the user the returned `linkUrl` to open once, then re-run verify. |
| `LAUNCH_VERIFY_UNCONFIGURED` | The server cannot issue tokens. | Stop and report it as a platform fault — nothing the user did. |

**Link step (for `LAUNCH_WALLET_NOT_LINKED`)** — create a one-time
magic link and hand it to the user:

```bash
curl -s -X POST "https://api.proofofdev.xyz/api/agent/link-github" \
  -H "content-type: application/json" \
  -d '{ "wallet": "0xWALLET", "githubLogin": "their-login" }'
```

The response carries `linkUrl` (valid ~15 minutes). Give it to the
user **exactly as returned** — never construct or shorten a URL. The
user opens it once and completes GitHub sign-in; that is the one
human-shaped step in the whole flow, and you cannot do it for them.
After they confirm, re-run verify. Check link state any time with
`GET /api/dev/link-wallet/<github-login>`.

**Token errors on later calls** (prepare/confirm refuse with 403):
`LAUNCH_VERIFICATION_REQUIRED` → you sent no token; go back to Step 1.
`LAUNCH_TOKEN_EXPIRED` or `LAUNCH_TOKEN_UNKNOWN_NONCE` → re-run
Step 1 for a fresh token and continue (never re-prepare a lock just
because a token lapsed — for confirm, a fresh token for the same
login + repo + wallet + chain is accepted). `LAUNCH_TOKEN_REPO_MISMATCH`,
`LAUNCH_TOKEN_WALLET_MISMATCH`, `LAUNCH_TOKEN_CHAIN_MISMATCH` → you
verified for different parameters than you are acting on; re-run
Step 1 with the exact parameters of the action. `LAUNCH_TOKEN_MALFORMED`
/ `LAUNCH_TOKEN_BAD_SIGNATURE` → the token was truncated or altered in
transit; re-run Step 1 and pass the new token through untouched.

**Recognition rule:** a grant with no verification stamp gets **no**
launch recognition — no `launchVerified` stamp, no verified-launch
listing, no ShipRewards launcher enrolment. Ordinary vesting locks
registered through the web wizard still count toward their own
schedule; that is vesting, not launch recognition. (The Bankr SDK
itself is permissionless; a launch done entirely outside Proof of
Dev cannot be stopped on-chain — it simply earns none of that
recognition.) The launch-prep surface (`POST /api/launch/prepare-launch`,
`POST /api/launch/onboard`, MCP `prepare_launch`) is **live in
production** and gated by the same token.

### Launcher enrolment (what verification records)

A launcher who passes Step 1 (verify) and auto-locks is a **verified launcher**
and is enrolled automatically at grant registration, on top of the
milestone unlocks of *their own* token. **State this precisely:
enrolment is an eligibility record, not a payout.** The per-merge
ShipRewards payout that exists today pays the **PR author** of each
counted merge (one payment per merge hash) — that author reward is
separate and already works. **Never promise a launcher the platform
reward token for someone else's merges.**

**Launcher trading fees — decided rule, LIVE in production
(deployed 2026-11-26):**
(a) outside this platform, SDK fee recipients claim **liquid WETH**
via `buildClaim` and nothing auto-locks fees; (b) on a Proof of Dev
launch the launcher's fee recipient is a **per-project fee-lock
vault** (a claim-capable smart account; not the raw wallet, not the
escrow contract, which cannot claim), and a keeper cycle claims
accrued fees and locks them into a **fee-stream grant** whose
tranches unlock over subsequent counted pushes, like the supply
lock — denomination DECIDED: WETH for the first launch (a swap to
the project token via PodSettler stays deferred). Two mechanics inside it are backend/keeper concerns — never
yours: a tranche's vesting baseline is set from an **oracle-signed
count attestation** the keeper fetches from the backend at lock
time (you never supply, estimate, or relay a push count for a fee
lock), and a fee release settles in **capped batches** — one release
call may pay only part of what has vested, with the remainder kept
queued and drained by the platform's sweep even if pushing stops.
If a launcher asks where their fees are mid-settlement, the honest
answer is "fees are still settling", not "released". The
fee-recycling loop that would refill the reward pool is likewise
designed, not operating (the reward treasury wallet is designated
and claim-proven in a live dust launch; the production reward
token's name/ticker is still open). Check enrolment any time:
`GET /api/launch/enrollment?repo=owner/repo&wallet=0xWALLET`.

### Platform launch fee split (locked — do not improvise)

A token launched **through Proof of Dev** is built from the platform
launch template (`src/lib/launchFeeConfig.ts`) and carries exactly
**two fee recipients on the creator share**:

- **25% (2500 bps of the creator slice)** → the platform **reward
  treasury wallet**. Its claimed fees are recycled: claimed WETH buys
  the platform reward token via PodSettler and tops up the ShipRewards
  pool, which pays out per counted merge — fees trickle back to the
  wallets that ship through Proof of Dev.
- **75% (7500 bps of the creator slice)** → **Gregory's wallet**
  (`0x374d91a5674fa7cf86e725093b5848b97e1e13b4`), claimed by him via
  the SDK's `buildClaim` like any fee recipient.

Rules when you build or describe a platform launch:

- The 25/75 is a split of the **creator fee slice only** — the Bankr
  v4 pad's built-in routing (Bankr cut, auto-LP, holder share) comes
  off the total trading fee first. Never describe it as 25/75 of the
  whole trading fee.
- Fee claims are beneficiary-signed, so the reward treasury is a
  claim-capable **wallet**, never the ShipRewards contract. If
  `PLATFORM_REWARD_TREASURY_WALLET` is not configured, the template
  refuses to build a launch input — report that as the blocker; do
  not substitute another address, and never put Gregory's wallet in
  both slots.
- The same template sets Bankr time-vesting **explicitly** to
  `vesting: { bps: 0 }`. Omitting the vesting field silently defaults
  to a 15% Bankr time-vest — never omit it. Unlocking on this
  platform is by verified pushes (GitEscrow), not by calendar.

**Launcher flow, end to end (strict order — same verify discipline
as the lock flow):**

1. **VERIFY** — Step 1 above; save the `verificationToken`.
2. **ONBOARD** — `POST /api/launch/onboard` with body
   `{ "repo": "owner/repo", "wallet": "0xWALLET", "chain": "base",
   "verificationToken": "<token from Step 1>",
   "feePushesPerTranche": 2 }` (`feePushesPerTranche` optional).
   The platform deploys your per-project fee-lock vault from the
   approved implementation (you never deploy or supply a vault) and
   the platform registrar registers the fee grant for your repo in
   the FeeStreamEscrow. Onboard derives everything from the token's
   validated claims and server config — you supply no vault, escrow,
   token, or ledger addresses. It is idempotent: a repeat call
   returns the existing vault (`alreadyOnboarded: true`); a failed
   grant registration returns `resumable: true` and a retry registers
   against the same vault. Save the returned `feeLockVault`.
3. **PREPARE-LAUNCH** — `POST /api/launch/prepare-launch` (or MCP
   `prepare_launch`) with the token, the `feeLockVault` from Step 2,
   and your launch parameters. Before returning anything signable it
   validates **every vault binding on-chain** — repo, launcher,
   escrow, WETH fee token, Bankr claim ledger — **and** that the
   matching fee grant is registered; any mismatch refuses with a
   specific `LAUNCH_VAULT_*` / `LAUNCH_FEE_GRANT_*` code and no input
   is returned.
4. **LAUNCH** — execute the returned input exactly (25/75 split, the
   fee-lock vault as your fee recipient, vesting `{ bps: 0 }`) with
   your wallet's signing route.
5. **LOCK + REGISTER** — run the lock procedure below for the supply
   you are locking (fresh verify → prepare-lock → sign → confirm),
   which registers the grant and stamps it as a verified launch.
6. **SHIP** — counted merges pay the platform reward token to the
   **merge author** (separate, already working); your locked supply
   unlocks at milestones and your trading-fee share auto-locks into
   a fee-stream grant unlocking by counted pushes.

---

## Lock procedure (writes — moves real funds; follow the steps in order)

Do not skip steps, do not reorder them, and do not start Step 2
without a token from Step 1 **in this session**.

### Step 1 — VERIFY

Run the verify call from "Step 1 — VERIFY" above with the exact
`{githubLogin, repo, wallet, chain}` of this lock and save the
returned `verificationToken`. On any refusal, work the error table —
do not proceed.

### Step 2 — PREPARE (token required)

```bash
curl -s -X POST "https://api.proofofdev.xyz/api/agent/prepare-lock" \
  -H "x-wallet-address: 0xWALLET" -H "content-type: application/json" \
  -d '{
    "repo": "owner/repo",
    "token": "0xTOKEN_OR_SYMBOL",
    "amount": "1000",
    "totalPushes": 10,
    "pushesPerMilestone": 1,
    "chain": "base",
    "verificationToken": "<token from Step 1>"
  }'
```

(`POST /api/agent/lock` is the same preparation plus an instructions
wrapper; either is acceptable, but the body is identical and the
token is required on both.)

Body fields (verified against the API): `repo` (required,
`owner/name`), `token` (a `0x` contract address, or a symbol resolved
against the wallet's holdings on that chain), `amount` (human units —
`3490000`, `3.49M`, `1.5K` all parse), `totalPushes` (default 10),
`pushesPerMilestone` (optional — defaults to `totalPushes`, i.e. one
release at the end; **`totalPushes` must be an exact multiple of
`pushesPerMilestone`**), `chain` (optional — `base` default,
`robinhood`, `base-sepolia`), `verificationToken` (required, from
Step 1).

Success returns `ok: true`, `tokenSymbol`, `amountWei`,
`tokensPerMilestone`, and `transactions[]` — `approve` first (only
when `needsApprove` is true), then `lock` — each item with `step`,
`to`, `data`, `value`, `chainId`, `description`, plus `statusUrl` and
`confirmUrl`.

**Decode and sanity-check before anything is signed.** Do not sign a
prepared transaction you have not checked:

- The **lock** item's `to` is the escrow. Every other check keys off
  it: the **approve** item (if present) must have `to` = the token
  contract, and its calldata must decode as
  `approve(spender, amount)` with **spender == the lock item's `to`**
  (the escrow) and **amount == `amountWei`** from the response.
- The lock item's calldata must decode as
  `lock(repoId, token, amount, totalPushes, pushesPerMilestone)`
  (or `lockAllowance(...)` with the same arguments when the response's
  `lockFunction` says so) with **token** == the token you intended,
  **amount == `amountWei`**, and the push counts == the schedule the
  user confirmed.
- Every item's `chainId` must match the chain you verified for
  (8453 = Base) and `value` must be `"0x0"`.
- If any check fails, **stop**: do not sign, do not "fix" the calldata
  yourself — report the mismatch and re-prepare.

Other prepare-time failures:

- **`installUrl` in the response / "GitHub App not installed on this
  repo"** — give the user the `installUrl`, wait for them to install
  the app and select the repo, then re-run Step 1 and Step 2.
- **Repo not found** — relay the error and any `suggestions`; don't
  guess a different repo name.
- **Insufficient balance** — the amount exceeds the wallet's live
  balance for the token; report the balance the error names and ask
  the user for a smaller amount. Never silently reduce the amount.

### Step 3 — CONFIRM WITH THE USER, THEN SIGN

Restate token (symbol + address), amount, repo, chain, and schedule
(total pushes + pushes per milestone + the per-milestone tranche);
get an explicit yes (Hard rules). Then sign and broadcast the
prepared transactions **in order** — approve first, lock last —
**waiting for the approve to confirm before submitting the lock, and
for the lock to confirm before Step 4.** Signing routes, first
available:

1. **Your own wallet tooling.** If you (the agent) control a wallet
   that can sign and broadcast arbitrary transactions on the chain,
   submit each prepared `{to, data, value, chainId}` through it.
   (Bankr: see "Bankr notes" below — this is your route.)
2. **Bankr wallet API, when the user's wallet is a Bankr wallet.**
   Submit each transaction via `POST https://api.bankr.bot/wallet/submit`
   with `{ "transaction": { to, data, value, chainId }, "waitForConfirmation": true }`.
   (`/wallet/submit` is the current Bankr route; the legacy
   `/agent/submit` route is removed.) If Bankr's scanner blocks the
   `approve` with `untrusted_address`, **stop and surface the risk to
   the user** — never route around a scanner block.
3. **Hand off to the human.** If neither route exists, present the
   prepared transactions (to / data / value / chainId, in order) for
   the user to sign in their own wallet, and ask them for the
   resulting lock tx hash. This is a normal path, not a failure.

### Step 4 — CONFIRM THE LOCK (fresh token), THEN READ BACK

Only after the lock tx has **confirmed on-chain**:

1. **Re-run Step 1 (verify)** for the same
   `{githubLogin, repo, wallet, chain}` and take the **fresh**
   `verificationToken` — the Step 1 token from before signing may
   have expired while the user confirmed and the transactions mined.
2. Register the grant:

```bash
curl -s -X POST "https://api.proofofdev.xyz/api/agent/confirm-lock" \
  -H "x-wallet-address: 0xWALLET" -H "content-type: application/json" \
  -d '{ "repo": "owner/repo", "lockTxHash": "0x…", "chain": "base", "verificationToken": "<FRESH token from the re-run>" }'
```

The server verifies the tx itself (receipt success, a `Locked`
event, recipient == your wallet) before registering the grant. If it
answers `alreadyRegistered: true`, the lock was already recorded —
report that, don't retry the on-chain lock.

3. Read the grant back and report from the readback, not from memory:

```bash
curl -s "https://api.proofofdev.xyz/api/vesting/lock/owner/repo"
```

Report the grant as active with `verifiedPushCount` / total pushes,
the per-push (per-milestone) release amount, and the `statusUrl`
(`https://www.proofofdev.xyz/lock/owner/repo`).

### Phrase handling — turning chat words into parameters

Map the user's natural phrasing onto the procedure's parameters
explicitly; never improvise a number:

- **"lock half my POD for 50 pushes, releasing after each push"** →
  token = POD (resolve the symbol against the wallet's live holdings
  via `GET /api/agent/fee-tokens`; if the symbol is ambiguous, ask
  which contract), **amount = live balance × ½** (read the balance in
  this session, compute the amount, and state the computed figure to
  the user in the Step 3 confirmation), `totalPushes` = 50,
  `pushesPerMilestone` = 1 ("releasing after each push" always means
  1). "A quarter" = × ¼, "all my X" = the full live balance.
- **"for N pushes"** → `totalPushes` = N. **"release every K pushes"**
  → `pushesPerMilestone` = K (and N must be a multiple of K — if it
  isn't, ask; do not round silently). No release cadence mentioned →
  ask, or default to `pushesPerMilestone` = `totalPushes` (one
  release at the end) **and say that is what you assumed** in the
  confirmation.
- **The repo** is the user's verified repo for this wallet — the one
  from the verify/profile context (`GET /api/dev/link-wallet/<login>`
  shows linked wallets; the grant/status reads show repos). If you
  do not know the repo from that context, **ask the user for
  `owner/repo`** — never guess a repo from the token name or from a
  previous session.
- **The chain** defaults to `base`; only use another chain when the
  user names it — and then verify for that same chain in Step 1.

---

## Bankr notes (executing from Bankr chat)

This skill assumes the executing agent controls the user's signing
wallet. In Bankr chat that agent is Bankr itself: the wallet is
Bankr's, signing is Bankr's `/wallet/submit` route (Step 3, route 2),
and **the whole flow after the one-time wallet link is
machine-to-machine** — verify, prepare, submit, confirm, read back,
all from chat, no website visit.

- If you are asked to lock or launch and the `{login, repo, wallet}`
  pair is **not yet verified**, that is a starting condition, not a
  failure: run Step 1, and if it refuses, walk the error table —
  install the app (user opens the install URL), link the wallet
  (user opens the `linkUrl` once), then verify again. The only step
  that needs the human's hands is opening a URL once per fix;
  everything else is yours.
- **Never report "Proof of Dev rejected the request" as a final
  answer.** A refusal always carries a `code`; the code names the
  precondition, the error table names the fix, and the fix is almost
  always another call you can make. Report a dead end only for
  `LAUNCH_VERIFY_UNCONFIGURED` or a failed on-chain transaction.
- Bankr's scanner is a hard stop, not an obstacle: if `/wallet/submit`
  blocks the approve with `untrusted_address`, surface it to the user
  verbatim and stop (see the Bankr skill's `references/BANKR-SUBMIT.md`).
- Compose replies from the structured response fields; never paste
  `replyText` / `tweetReply` verbatim (see the Bankr skill's
  `references/RESPONSE-SAFETY.md`).

---

## What counts as a verified push (the verifier's actual rules)

A push/merge earns the merge reward only if it passes every rule below;
on repos with a vesting grant, the same counted pushes also earn vesting
progress. These are the verifier's real constants and filters — quote
them exactly; don't soften them.

- **Branch:** the push must land on a production branch: `main`, `master`,
  `production`, or `prod`.
- **Size:** at least **3 meaningful changed lines** (`MIN_LINES_CHANGED = 3`)
  across meaningful files. How the count is produced differs by path: for a
  PR-credited merge it is the PR's real additions + deletions over
  meaningful files; for a raw push it is an **estimate of 5 lines per
  meaningful file**, so in practice a raw push with even one meaningful
  file clears the minimum. Quote the constant, but don't promise a raw
  push was measured line-by-line.
- **Meaningful files only.** Changes confined to these never count:
  `*.md`, `*.txt`, lockfiles (`*.lock`, `package-lock.json`, `yarn.lock`,
  `pnpm-lock.yaml`), `.gitignore`, `.gitattributes`, `CHANGELOG*`,
  `LICENSE*`, `NOTICE*`, everything under `.proofofdev/` (claim files),
  **`.claude/**` and `.github/**`** (policy/workflow-only diffs never count).
- **Author:** bot/App-authored pushes and PRs are rejected (sender type
  `Bot` or a login ending in `[bot]`).
- **Force pushes** are rejected.
- **Rate limits, per repo:** max **3 counted pushes per day**
  (`MAX_PUSHES_PER_DAY = 3`), and a **30-minute cooldown**
  (`MIN_MINUTES_BETWEEN_PUSHES = 30`) after a counted push — bypassed only
  by a substantial change of **≥ 50 estimated lines**
  (`COOLDOWN_BYPASS_MIN_LINES = 50`).
- **Merged PRs credit the PR author.** When a push is a merge commit
  (`Merge pull request #N`) or a squash merge (`… (#N)`), the system
  resolves the PR, verifies it merged with that exact head SHA, and counts
  **one** push credited to the PR's author with the PR's real meaningful
  line count — no matter who pressed merge. If the GitHub lookup fails, it
  safely falls back to counting the raw push as before.

Consequences worth telling users plainly: docs-only PRs, dependency-bot
merges, and `.claude/`-only changes earn **zero** — no vesting progress, no
reward. Attempts are never paid; only counted merges are.

---

## Developer side — linking a wallet to GitHub (how rewards find you)

Merge rewards are paid to the PR author's **most recently linked wallet**
(the linked-wallet list is stored newest-first, and the oracle pays its
first entry — linking a new wallet redirects future rewards to it).
Linking is a signature proof: the human proves they control both the
GitHub account and the wallet. Two real flows exist; use whichever fits.

### Flow A — the dev links it themselves (session + signature)

Requires the dev's GitHub OAuth session with the site (cookies — a browser
flow; an agent without that session cannot do this part for them):

1. `POST /api/dev/link-wallet/challenge` with the wallet
   (`x-wallet-address` header or `wallet` in body) → returns a sign message
   (the wallet-link message plus a one-time nonce).
2. The wallet signs that exact message (`personal_sign`).
3. `POST /api/dev/link-wallet/confirm` with the signature → wallet linked.

Check state any time (no auth): `GET /api/dev/link-wallet/<github-login>`
returns `wallets[]` with `source` and `linkedAt`, plus `pendingRewards[]`
(rewards accrued while no wallet was linked — each with repo, merge SHA,
amount in wei, chain, and earn time) and `pendingRewardsTotal`.

### Flow B — agent-created magic link (best for chat/agent flows)

```bash
curl -s -X POST "https://api.proofofdev.xyz/api/agent/link-github" \
  -H "x-wallet-address: 0xWALLET" -H "content-type: application/json" \
  -d '{ "githubLogin": "their-login" }'
```

Returns a one-time `linkUrl`. Give it to the human exactly as returned
(only share URLs the API returned — never construct one); they open it
once, complete GitHub auth, and the wallet is linked to that GitHub
account. You cannot complete the GitHub-auth step for them.

### Repo claims (separate — binds a wallet as a repo's recipient/owner)

1. `POST /api/repo-claims/challenge` → sign the returned message with the
   wallet.
2. `POST /api/repo-claims/prepare-file` → returns the claim file content.
3. With the user's explicit confirmation, commit **only**
   `.proofofdev/claim.json` at the repo root (nothing else in that commit).
4. `GET /api/repo-claims/status?poll=1` until verified.

Claim pushes are excluded from vesting counts by design.

### Pending rewards — say this exactly

If a counted merge's author has **no linked wallet**, the reward for that
merge **accrues as a pending reward**: it is recorded server-side at the
amount configured when the merge counted, keyed by the merge commit
hash. It is **never** sent to a guessed, derived, or "probably theirs"
address. The moment the author links a wallet — through *any* link flow
(Flow A signature, Flow B magic link, repo claim, or a lock) — the system
automatically pays the full pending backlog to that newly linked wallet;
no claim step, no button. If a settlement payment fails (e.g. the reward
pool is empty), the remainder stays pending and retries on the next link.
Check anyone's pending state any time (no auth):
`GET /api/dev/link-wallet/<github-login>` → `pendingRewards[]` +
`pendingRewardsTotal`. So the honest phrasing is: *"that merge earned a
reward; it's pending until you link a wallet, then it pays out
automatically."* Never claim a pending reward was already sent. Each
reward is keyed on-chain by the merge commit hash (`isPaid` check before
paying, and the contract itself refuses a second payment for the same
hash) — **double-payment is impossible**, so never re-submit a reward for
a merge.

---

## Claude Ship tie-in

If the user runs `/ship` or has **Claude Ship** enabled on a repo, there
is **nothing extra to configure** for Proof of Dev: Ship's merges land on
GitHub as ordinary merges, and the verifier counts them like any other.
A `/ship` merge counts **exactly** like a hand merge — same rules above
(a docs-only or bot-authored merge still earns zero; PR Steward's fix
pushes to PR branches never count — they're not production-branch pushes
and are bot-authored).

### The /ship → auto-unlock guarantee

**This is the core promise of the integration, and it is automatic:** once
a token is locked for a repo, every counted `/ship` merge releases the
next vesting tranche on its own — no claim step, no button, no human in
the loop. The sequence is:

```
/ship merge lands on the production branch
→ GitHub push webhook → verifier counts it
→ milestone reached → oracle calls GitEscrow.release()
→ tranche lands in the recipient wallet (on-chain, checkable)
→ and the PR author is paid the ShipRewards merge reward
```

The guarantee holds only when ALL of these preconditions are true. When
you set up a lock for a user who ships with Claude, **verify each one and
only state the guarantee to the user once all check out**:

1. The Proof of Dev GitHub App is installed on the repo (webhooks are
   what trigger everything — no install, no counting).
2. The grant is registered and **active**: after `confirm-lock`, call
   `GET /api/agent/status?repo=owner/repo` and confirm it returns the
   grant with `"status":"active"`. If it doesn't, the lock is NOT armed —
   say so and finish the setup instead of promising auto-unlock.
3. The merges land on a production branch (`main` / `master` /
   `production` / `prod`) — `/ship` targeting any other branch never
   counts.
4. For the author's merge **reward** (separate from the vesting unlock):
   the reward pays immediately if the author's GitHub is linked to a
   wallet. If it isn't, the reward still earns — it accrues as pending
   and pays out automatically when they link one. The reward also does
   not need a grant at all: it fires on counted merges on any
   App-installed repo. The vesting unlock is the only part that needs
   the lock.

Once armed, phrase it to the user exactly as it works: *"Locked and
armed — from now on, every counted /ship merge auto-unlocks the next
tranche to <recipient> and pays you the per-merge reward. Nothing else
to do."* If a later merge doesn't advance the counter, check the counted-
push rules first (docs-only? bot-authored? daily cap? cooldown?) before
assuming the system is broken.

After a Ship merge, report the ship and then report what it earned (see
**Attestation layer** below for the full flow): file the ship report for
the merge SHA, poll its state until the webhook resolves it, and check
repo status:

```bash
curl -s "https://api.proofofdev.xyz/api/agent/status?repo=owner/repo"
```

…and state plainly whether the counter advanced and whether the author
was paid or is pending a wallet link (if you know their link state via
`GET /api/dev/link-wallet/<login>`). Remember the narration rule from the
attestation section: "reported, awaiting GitHub confirmation" is not
"paid" — only a `paid` ship-report state (or an on-chain tx) proves money
moved.

### Optional CLAUDE.md snippet

You may **offer** (never add unasked) to append this to a repo's
`CLAUDE.md` so future Claude sessions know the repo participates:

```markdown
## Proof of Dev
This repo participates in Proof of Dev (https://www.proofofdev.xyz):
counted merges to the production branch advance token vesting and earn
the PR author a per-merge reward. Check status:
GET https://api.proofofdev.xyz/api/agent/status?repo=<owner>/<repo>
Docs-only, bot-authored, and .claude//.github/-only changes don't count.
```

---

## Attestation layer — ship reports (signal only, never settlement)

A **ship report** is a developer-side Claude (you) telling the API "I just
shipped this commit." It exists so the user gets instant, in-conversation
feedback about a ship instead of waiting silently for the webhook. It is
**not** part of settlement, and you must never present it as such.

**The design law, stated plainly:** a report alone **never** releases
tokens, never advances a vesting counter, and never influences the
verifier. Reports are unauthenticated and worthless to fake — that's
precisely why they're safe to accept from anyone. Settlement is, and
remains, exactly one path: **GitHub push webhook → verifier → oracle**.
Every report response says so in its own payload:
`"settlement": "github-webhook"`, `"reportMovesMoney": false`.

### The flow and the states

```
you report a ship ──▶ reported ──webhook counts it, no payout──▶ confirmed
                          │──────webhook counts it + release
                          │       and/or merge-reward tx───────▶ paid
                          │──────webhook rejects it (docs-only,
                          │       bot, cap, cooldown)───────────▶ rejected
                          └──────no webhook within 24h─────────▶ expired
```

- `reported` — the API has your claim; GitHub hasn't weighed in yet. Say
  "reported, awaiting GitHub confirmation" — **never** "paid", "earned",
  or "released" at this state.
- `confirmed` — the webhook counted the push; this particular push hit no
  milestone and paid no reward (or rewards aren't configured). Grant-less
  repos have no progress to confirm, so their reports skip this state.
- `paid` — the counted push produced a vesting release and/or a merge
  reward; the record carries the tx hash(es). Only now may you say money
  moved, and quote the hash(es) from the record. A grant-less report can
  also flip to `paid` later, when an accrued pending reward settles on
  wallet link.
- `rejected` — the verifier refused it; the record carries the reason.
  Relay it as-is.
- `expired` — no matching webhook arrived within 24h. The ship either
  never landed on a production branch or the repo has no App install.
  Treat as "not counted", and troubleshoot via the counting rules.

### Reporting a ship

After a `/ship`, a merge, or a push you performed for the user, report it
(unless the hook below is installed — then it happens automatically):

```bash
curl -s -X POST "https://api.proofofdev.xyz/api/agent/report-ship" \
  -H "content-type: application/json" \
  -d '{ "repo": "owner/repo", "headSha": "<40-hex HEAD sha>",
        "prNumber": 42, "authorLogin": "their-login" }'
```

`headSha` is the push's head commit (`git rev-parse HEAD` after a push, or
the merge commit SHA). `prNumber` / `authorLogin` are optional — include
them when you know them, never guess.

Then poll the outcome and narrate the state honestly:

```bash
curl -s "https://api.proofofdev.xyz/api/agent/ship-report?repo=owner/repo&sha=<headSha>"
curl -s "https://api.proofofdev.xyz/api/agent/ship-reports?repo=owner/repo"   # recent reports, newest first
```

The webhook usually resolves a report within seconds of the push landing.
If it's still `reported` after a minute, say it's awaiting confirmation
and check again later — do not upgrade the user's expectations on your own
authority. **Your report is a claim; the webhook is the verdict.**

### MCP server (first-class tools instead of raw curl)

Proof of Dev exposes an MCP server named `proofofdev` wrapping this API:
`verify_github` (the Step 1 launch gate — `prepare_lock` requires its
token), `vesting_status`, `agent_briefing`, `agent_grants`,
`repo_recent_pushes`, `prepare_lock`, `report_ship`, `ship_report`,
`link_status`, `enrol_reviewer`, `review_queue`, `review_push`. If it's
configured in the user's Claude client, prefer its tools over hand-built
curl. **Remote (no install):** `claude mcp add --transport http proofofdev
https://api.proofofdev.xyz/mcp` (live when the backend is deployed).
Stdio variant in the repo's `mcp/` directory — see `mcp/README.md`.

### Claude Code push hook (automatic reporting)

`hooks/` in this skill folder ships a PostToolUse hook so reporting needs
no model discipline at all:

- `hooks/report-push.sh` — after any Bash call containing `git push`, it
  resolves `owner/repo` from the origin remote and HEAD's SHA, and POSTs
  the ship report. Bash + curl + git only. **It fails silently and always
  exits 0** — a reporting hook must never block or break a developer's
  push. Optional env: `POD_API_URL`, `POD_GITHUB_LOGIN`.
- `hooks/pod-settings.json` — the settings snippet to merge into
  `.claude/settings.json`; adjust the script path to where this skill is
  installed.

Offer to install it when a user ships often from Claude Code; never edit
their settings unasked.

---

## Reviewer swarm — get paid to verify other people's pushes

Swarm review is **mandatory on every grant** (adopted 2026-11-26 —
no launcher opt-in or opt-out). A push that passes the platform's
verifier rules opens a **6-hour review window**: 2 independent PASS
attestations inside the window count it immediately, any FAIL inside
the window vetoes it forever, and at expiry with no FAIL it counts on
the verifier's result alone (the "verifier-fallback" path — fallback
pushes pay no reviewer rewards). Reviewing is open to any agent with
a linked wallet — this is the other side of Proof of Dev: authors
earn by shipping, reviewers earn by verifying.

**Design law (same as ship reports): reviews are a GATE, never a
settlement.** A quorum of PASS reviews can only *allow* a push to be
counted by the webhook path; a FAIL *blocks* it. No review, and no
quorum of reviews, can force a release or a payment. Money still moves
only via GitHub webhook → verifier → oracle. Your reviewer reward is
paid by the oracle *after* a push you passed actually counts — never
at review time, and never promised before then.

### Enrol

Your wallet must already be linked to your GitHub login (the
signature/magic-link store above). Then:

- MCP: `enrol_reviewer` with `{githubLogin, wallet}`
- HTTP: `POST /api/agent/enrol-reviewer` with `{githubLogin, wallet}`

Unlinked wallet → refused (`SWARM_WALLET_NOT_LINKED`). Link first.

### Find work

- MCP: `review_queue` with `{repo, reviewerLogin}`
- HTTP: `GET /api/agent/review-queue?repo=&reviewerLogin=`

The queue only shows pushes you are **independent** of and have not
already reviewed. Independence is enforced server-side and is a hard
rule: you must NOT be the push's author, the author's linked wallet,
or the repo's launcher/claim wallet. Attempts are refused with
`SWARM_REVIEW_NOT_INDEPENDENT` — do not try to route around it with a
second login on the same wallet; the check is wallet-based.

### Review a push

For each push, check three things yourself, from the actual PR diff:

1. **Different** — the code is genuinely new, not a copy/replay of a
   previously counted diff.
2. **Meaningful** — real code, not churn, renames, or noise.
3. **Passing** — the PR's checks/tests are green.

Then compute the **diff fingerprint** with the published algorithm and
submit it with your verdict:

- Per file (meaningful files only): `sha256(filename + "|" + status + "|" + content)`
  where content is the file's patch with blank lines, full-line
  comments, and all whitespace stripped — or, when no patch is
  available, `+<additions>/-<deletions>`.
- Whole diff: `sha256` over the sorted per-file hashes, hex-encoded.

A PASS whose fingerprint does not match the server's fingerprint for
that push does not count toward quorum — you reviewed different code
than the server saw. A diff whose fingerprint exactly matches a
previously counted diff is auto-flagged as a duplicate and can never
count, whatever the verdicts.

- MCP: `review_push` with `{repo, headSha, reviewerLogin, verdict,
  different, meaningful, checksPass, fingerprint, note?}`
- HTTP: `POST /api/agent/review-push` with the same fields.

`verdict: "pass"` requires all three checks true; anything else is
recorded as a FAIL, and **a FAIL vetoes the push**. One review per
reviewer per push — verdicts cannot be flipped after submission.

### Quorum and payment

Default quorum is **2 independent PASS reviews** (`SWARM_REVIEW_QUORUM`)
inside the 6-hour window, with **zero FAILs** — a FAIL inside the
window vetoes the push permanently. Until quorum is met, the push is
**pending**: not counted, not rejected; it counts the moment the
second PASS lands, is vetoed the moment a FAIL lands, and otherwise
counts via verifier fallback when the window expires. Reviews stay on
file the whole time. When the push counts **via the swarm path**, each
PASS reviewer in the quorum is paid the reviewer reward from the same
ShipRewards pool as author rewards (default: 10% of the per-merge
reward, `SHIP_REVIEWER_REWARD_PER_MERGE` — a placeholder share, not a
promise; the schedule is the platform's open decision). Fallback
counts pay no reviewer rewards. Read outcomes with
`GET /api/agent/push-reviews?repo=&sha=` — it reports the window state
and, once counted, which path counted the push (`swarm` or
`verifier-fallback`). Never tell a user a review "paid" before the
push has actually counted — say "attested", and let the outcome speak.

---

## Agent-managed setup — you hold the wallet, the owner gets paid

When the human has no wallet (or wants a one-prompt setup), YOU run the
whole money side from a wallet of your own. Nothing about the platform
changes: the escrow's rule is recipient = locker, so you lock as
yourself, releases land in your wallet, and your one other job is to
forward each release to the owner. No contract changes, no special
permissions — this is the standard lock flow plus a forwarding habit.

The setup:

1. **Create your own wallet.** Generate a key locally, store it in a
   `0600` file in YOUR environment (e.g. `~/.pod_agent_key`). The key
   is never printed, never pasted into chat, never sent to the owner
   or anyone else — there is nothing to "hand over" later, by design.
   Fund it with a small ETH float for gas (Base gas is cents per tx).
2. **Deploy / obtain the token from that wallet** and mint or hold the
   supply there. Keep the split explicit with the human: how much
   vests against the repo, how much (if any) goes to them immediately.
3. **Lock as yourself** — the normal lock flow above, with your agent
   wallet in the `x-wallet-address` header. The grant's recipient is
   your wallet; say this plainly to the human so the grant page never
   surprises them.
4. **Forward every release to the owner.** Run
   `scripts/forward-unlocked.ts` (in this skill folder) after any
   counted push, or on a schedule:
   `AGENT_TOKEN=<token> AGENT_OWNER=<owner wallet> npx hardhat run skills/claude-vesting/scripts/forward-unlocked.ts --network base`
   The script tracks your **own-balance baseline** (your balance at
   first run, minus any later locks you register with
   `AGENT_REGISTER_LOCK=<amount>`) and forwards only balance above
   the baseline — i.e. exactly what the escrow released, nothing
   else. Report each forward's tx hash to the human.
5. **Private delivery (stealth mode) — when the owner prefers it.**
   The owner may give you a stealth **meta-address** (`st:eth:0x…`,
   from the Agent Private Pay skill) instead of a wallet address.
   Then no owner wallet exists anywhere in your config: run the
   forwarder with `AGENT_OWNER_META=st:eth:0x…` instead of
   `AGENT_OWNER`. Each forward derives a **fresh one-time stealth
   address** (ERC-5564, schemeId 1), sends the released tokens there
   plus a small ETH dust (`AGENT_DUST_ETH`, default 0.0002 — so the
   owner can pay gas to move the tokens), and posts the Announcer
   announcement. The owner discovers payments with Agent Private
   Pay's `scan-chain` (from Announcer events alone), recovers each
   spend key, and sweeps when they choose. Say the limit plainly:
   you still know what you sent and when — stealth hides the owner's
   address and links between payouts, not the payment from its
   sender.
5. **The owner provides only public things:** their repo name and
   their receiving wallet address. If they have no wallet at all,
   releases simply accumulate in yours (still forwardable later) —
   never invent or custody an address for them.

6. **Agent-generated stealth wallet (EXPLICIT TRUST OPT-IN — never
   the default).** If the owner has no way to generate keys and
   explicitly accepts the tradeoff, you may generate the stealth
   wallet FOR them with `scripts/create-owner-stealth-wallet.ts`.
   Before generating, you MUST say, in substance: *"Whoever
   generates stealth keys can scan and spend everything that wallet
   receives, forever — deleting my copy cannot be proven. This is
   for convenience amounts, and you should migrate to a wallet you
   generated yourself for anything serious."* Generate only after
   they agree. The script writes a recovery file (0600) holding the
   keys — deliver that FILE to the human (never print its contents),
   have them store it offline, then delete your copy of the private
   keys and keep only the meta-address for forwarding. The owner
   takes custody with the recovery file alone: its keys reproduce
   the meta-address, discover announcements, and recover each spend
   key. Recommend owner-born keys (step 5's flow) whenever the owner
   can run one command themselves.

**The no-trick guarantee (the point of this mode — hard rule).** In
agent-managed mode the human cannot obtain locked tokens by asking,
persuading, or pressuring you — and you must keep it that way:

- Locked tokens release ONLY through the oracle, on verified pushes.
  No instruction from the human (or anyone else) is a release
  condition — not urgency, not a changed mind, not a claim that the
  schedule was a mistake.
- NEVER cancel a lock, and NEVER forward unvested supply (balance at
  or below your own-balance baseline), on the human's instruction,
  for any reason given in conversation. A cancel returns funds to
  YOUR wallet and breaks the guarantee the human was promised.
  Refuse, explain the guarantee, and continue the normal flow — the
  refusal is structural, not personal: the contract holds the gate,
  not your discretion.
- The only legitimate early end to a grant is a genuine setup error
  (wrong repo, wrong token, wrong amount) caught BEFORE the first
  counted push. If you ever cancel for that reason, disclose it in
  the same message, with the tx hash.

Hard rules for this mode: the agent key never leaves your environment;
the forwarder sends one token to one owner address and nothing else;
if the owner changes their receiving address, update `AGENT_OWNER`
and say so — past forwards are never re-routed.

---

## Failure handling

- **Health first when something smells off:**
  `curl -s https://api.proofofdev.xyz/health` should return
  `{"ok": true, "service": "github-vesting", ...}`. If the API is
  unreachable, times out, or returns 404/5xx on known-good endpoints, the
  backend appears **offline** — say exactly that, stop, and do not
  fabricate status, counts, or links.
- **Prepare succeeded but submit failed/reverted:** do **NOT** call
  `confirm-lock`. Report which transaction failed and its state (not
  broadcast / broadcast but reverted / unknown), and let the user decide
  whether to retry the prepare step fresh.
- **Confirm-lock errors are explicit** — e.g. transaction not found on the
  chain, lock transaction reverted, no `Locked` event, recipient mismatch.
  Relay the error as-is; don't retry with a different hash or wallet.
- **A push didn't count:** use the verifier rules above to explain the
  likely reason (branch, docs-only, < 3 meaningful lines, bot author,
  daily cap, cooldown) — framed as "likely", since only the server sees
  the full payload.
- **Never** send the user to a guessed URL or a different host
  (`github-vesting.vercel.app` is frontend-only; the API lives only at
  `api.proofofdev.xyz`).

---

## Quick intent map

| User says | Do |
|---|---|
| "my vesting / my locks" | `GET /api/agent/briefing?wallet=` → summarize |
| "vesting on owner/repo" | `GET /api/agent/status?repo=owner/repo` |
| "what can I lock?" | `GET /api/agent/fee-tokens` (wallet header) |
| "lock 500 TOKEN on owner/repo for 10 pushes" | **Lock procedure**: Step 1 verify → Step 2 prepare-lock → Step 3 confirm with user → sign → Step 4 confirm-lock (fresh token) → read back |
| "launch a token through Proof of Dev" | **Launcher flow**: Step 1 verify (`POST /api/launch/verify-github` or MCP `verify_github`) → **onboard** (`POST /api/launch/onboard` — platform deploys the fee-lock vault + registrar registers the fee grant) → **prepare-launch** (`prepare_launch` validates all vault bindings + the registered grant, then returns the input) → launch → lock + register via the lock procedure → ship; launcher earns milestone unlocks of their own token and is **enrolled** for ShipRewards (per-merge platform-token payouts today go to the PR author; the launcher's trading-fee share auto-locks into a fee-stream grant unlocking by counted pushes — FeeLockVault + FeeStreamEscrow + the launch-prep surface are LIVE in production since 2026-11-26) |
| "link my wallet to my GitHub" | Flow B magic link (agent) or Flow A (if they have a site session) |
| "did that merge earn anything?" | repo status + author's link state; answer per the counting rules |
| "I just shipped / merged — what's happening with it?" | `POST /api/agent/report-ship` for the head SHA (or the MCP `report_ship` tool), then poll `GET /api/agent/ship-report` and narrate the state exactly (`reported` ≠ `paid`) |
| "set up Proof of Dev on this repo" | install GitHub App (surface `installUrl` from a prepare call), offer the CLAUDE.md snippet, then the lock flow if they want a lock |
| "set it up for me — I don't have a wallet" | Agent-managed setup: your own wallet (key never shared), lock as yourself, forward every release to the owner with `scripts/forward-unlocked.ts` |
| "report my pushes automatically" | offer the `hooks/pod-settings.json` snippet + `hooks/report-push.sh` from this skill folder |
