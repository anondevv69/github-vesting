---
name: claude-vesting
description: Proof of Dev — GitHub-gated token vesting (proofofdev.xyz). Lock any ERC-20 on Base so verified pushes and merged PRs release it on a milestone schedule, check vesting progress for a wallet or repo, link a GitHub account to a wallet, and earn the per-counted-merge ShipRewards payout as a PR author. Use when the user mentions Proof of Dev, proofofdev, github vesting, locking tokens against a repo, vesting progress / verified pushes / milestones, linking a wallet to GitHub, merge rewards, or asks what a Claude Ship / /ship merge earned. Works entirely over the agent API at https://api.proofofdev.xyz — no website required.
tags: [github, vesting, claude, base, defi, proofofdev, rewards]
version: 1
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
   from a pre-funded `ShipRewards` pool — **whether or not that repo has any
   vesting lock**. The reward goes to the author's first GitHub-linked
   wallet and is keyed by the merge commit hash, so a merge can never be
   paid twice.

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

## Lock flow (writes — moves real funds)

### 1. Prepare

```bash
curl -s -X POST "https://api.proofofdev.xyz/api/agent/lock" \
  -H "x-wallet-address: 0xWALLET" -H "content-type: application/json" \
  -d '{
    "repo": "owner/repo",
    "token": "0xTOKEN_OR_SYMBOL",
    "amount": "1000",
    "totalPushes": 10,
    "pushesPerMilestone": 2,
    "chain": "base"
  }'
```

Body fields (verified against the API): `repo` (required, `owner/name`),
`token` (a `0x` contract address, or a symbol resolved against the wallet's
holdings on that chain), `amount` (human units — `3490000`, `3.49M`, `1.5K`
all parse), `totalPushes` (default 10), `pushesPerMilestone` (optional —
defaults to `totalPushes`, i.e. one release at the end), `chain` (optional —
`base` default, `robinhood`, `base-sepolia`).

Success returns `ok: true` and `transactions[]` — usually `approve` (if
needed) then `lock` — each with `to`, `data`, `value`, `chainId`,
`description`, plus `statusUrl`, `confirmUrl`, and `bankrPrompt`.

Possible prepare-time failures:

- **`installUrl` in the response / "GitHub App not installed on this
  repo"** — the Proof of Dev GitHub App must be installed on the repo
  first. Give the user the `installUrl`, wait for them to install it and
  select the repo, then retry the prepare call.
- **Repo not found** — relay the error and any `suggestions`; don't guess a
  different repo name.

### 2. Confirm with the user, then sign

Restate token, amount, repo, chain, and schedule; get an explicit yes
(Hard rules). Then sign and broadcast the prepared transactions **in
order** (approve first, lock last), waiting for the **lock** transaction
to confirm. Claude has **no built-in wallet** — use the first route
available:

1. **Your own wallet tooling.** If you (the agent) have a wallet tool that
   can sign and broadcast arbitrary transactions on Base, submit each
   prepared `{to, data, value, chainId}` through it.
2. **Bankr, if you're running inside Bankr.** Submit each transaction via
   `POST https://api.bankr.bot/wallet/submit` with
   `{ "transaction": { to, data, value, chainId }, "waitForConfirmation": true }`.
   (The API response text may still say `agent/submit` — `/wallet/submit`
   is the current Bankr route.) If Bankr's scanner blocks the `approve`
   with `untrusted_address`, **stop and surface the risk to the user** —
   never route around a scanner block.
3. **Hand off to the human.** If neither route exists, present the prepared
   transactions (to / data / value / chainId, in order) for the user to
   sign in their own wallet, and ask them for the resulting lock tx hash.
   This is a normal path, not a failure.

### 3. Confirm the lock

Only after the lock tx has **confirmed on-chain**:

```bash
curl -s -X POST "https://api.proofofdev.xyz/api/agent/confirm-lock" \
  -H "x-wallet-address: 0xWALLET" -H "content-type: application/json" \
  -d '{ "repo": "owner/repo", "lockTxHash": "0x…", "chain": "base" }'
```

The server verifies the tx itself (receipt success, a `Locked` event,
recipient == your wallet) before registering the grant. If it answers
`alreadyRegistered: true`, the lock was already recorded — report that,
don't retry the on-chain lock.

### 4. Verify

```bash
curl -s "https://api.proofofdev.xyz/api/agent/status?repo=owner/repo"
```

Report the grant as active with its schedule and the `statusUrl` from the
confirm response.

---

## What counts as a verified push (the verifier's actual rules)

A push/merge earns vesting progress **and** the merge reward only if it
passes every rule. These are the verifier's real constants and filters —
quote them exactly; don't soften them.

- **Branch:** the push must land on a production branch: `main`, `master`,
  `production`, or `prod`.
- **Size:** at least **3 meaningful changed lines** (`MIN_LINES_CHANGED = 3`)
  across meaningful files, estimated from the PR/push diff.
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

Merge rewards are paid to the PR author's **first linked wallet**. Linking
is a signature proof: the human proves they control both the GitHub
account and the wallet. Two real flows exist; use whichever fits.

### Flow A — the dev links it themselves (session + signature)

Requires the dev's GitHub OAuth session with the site (cookies — a browser
flow; an agent without that session cannot do this part for them):

1. `POST /api/dev/link-wallet/challenge` with the wallet
   (`x-wallet-address` header or `wallet` in body) → returns a sign message
   (the wallet-link message plus a one-time nonce).
2. The wallet signs that exact message (`personal_sign`).
3. `POST /api/dev/link-wallet/confirm` with the signature → wallet linked.

Check state any time (no auth): `GET /api/dev/link-wallet/<github-login>`
returns `wallets[]` with `source` and `linkedAt`.

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

If a counted merge's author has **no linked wallet**, the reward is
**pending**: the oracle skips payment for that merge and logs the reason.
It is **never** sent to a guessed, derived, or "probably theirs" address.
Tell the author to link a wallet (Flow A or B) so future counted merges
pay out, and never claim a pending reward was sent. Once linked, rewards
pay to the first linked wallet. Each reward is keyed on-chain by the
merge commit hash (`isPaid` check before paying, and the contract itself
refuses a second payment for the same hash) — **double-payment is
impossible**, so never re-submit a reward for a merge.

---

## Claude Ship tie-in

If the user runs `/ship` or has **Claude Ship** enabled on a repo, there
is **nothing extra to configure** for Proof of Dev: Ship's merges land on
GitHub as ordinary merges, and the verifier counts them like any other.
A `/ship` merge counts **exactly** like a hand merge — same rules above
(a docs-only or bot-authored merge still earns zero; PR Steward's fix
pushes to PR branches never count — they're not production-branch pushes
and are bot-authored).

After a Ship merge, report what it earned:

```bash
curl -s "https://api.proofofdev.xyz/api/agent/status?repo=owner/repo"
```

…and state plainly whether the counter advanced and whether the author
was paid or is pending a wallet link (if you know their link state via
`GET /api/dev/link-wallet/<login>`).

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
| "lock 500 TOKEN on owner/repo for 10 pushes" | prepare → confirm with user → sign → confirm-lock → verify |
| "link my wallet to my GitHub" | Flow B magic link (agent) or Flow A (if they have a site session) |
| "did that merge earn anything?" | repo status + author's link state; answer per the counting rules |
| "set up Proof of Dev on this repo" | install GitHub App (surface `installUrl` from a prepare call), offer the CLAUDE.md snippet, then the lock flow if they want a lock |
