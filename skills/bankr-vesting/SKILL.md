---
name: bankr-vesting
description: Lock ANY ERC-20 on Base for GitHub-gated vesting — status, wallet tokens, full lock flow from chat or X. No token allowlist.
tags: [github, vesting, bankr, base, defi, space]
---

# GitHub Vesting — Bankr agent skill

Lock **any ERC-20 on Base** for GitHub-gated vesting. Earn tokens back by shipping verified commits to a repo. **There is no token allowlist** — TMP, Space, USDC, or any `0x` contract works.

**Site:** `{VESTING_SITE_URL}` (explore, lock pages, dev profiles, create flow)  
**API:** `{VESTING_API_URL}` (agent + webhooks)

---

## CRITICAL — any token

- **Any ERC-20 on Base** can be locked. Symbols resolve from **wallet holdings** or pass a **`0x` address**.
- `known-escrow.json` → `supportedTokens` is **not an allowlist**. It only marks streaming tokens (Space → `lockAllowance`).
- **Never** say "only Space and TEST" or "TMP isn't supported" without calling `POST {API}/api/agent/lock` first.
- Do **not** confuse a token's native `release()` vesting with **GitHub vesting** (GitEscrow + verified pushes).

---

## Install

```text
install GitHub Vesting skill at https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting
```

---

## What users mean

| Term | Meaning |
|------|--------|
| **Push** | GitHub `push` event to `main` / `master` / `production` / `prod` |
| **Verified push** | Push that passes anti-spam rules (code files, ~10+ lines, not force-push, rate limits) |
| **Milestone** | Every **N** verified pushes → one on-chain token release |
| **Streaming lock** | Bankr tokens (Space): stay in wallet; oracle pulls on milestone via allowance |
| **Escrow lock** | Standard ERC-20: tokens held in GitEscrow contract |

Example: **10 total pushes**, **10 per milestone** → **1 milestone** → full amount releases after **10 verified pushes**.

---

## Mandatory routing

```
if message mentions github vesting / lock tokens / vesting progress / verified pushes / milestones:
  1. use_skill("bankr-vesting")
  2. Read ONE-LINE-INTENTS.md
  3. Resolve linked wallet → x-wallet-address header
  4. Call AGENT-API.md endpoint BEFORE replying
  5. Paste replyText / tweetReply verbatim — URL on its own line
```

**Tweet = DM** — same pipeline on `@bankrbot` intake.

---

## Agent API (reads)

All reads accept `?wallet=0x…` **or** header `x-wallet-address: 0x…`.

| User says | Call |
|-----------|------|
| my vesting / my locks / vesting progress | `GET {API}/api/agent/briefing?wallet=0x…` |
| list my github vesting | `GET {API}/api/agent/grants?wallet=0x…` |
| vesting on **owner/repo** | `GET {API}/api/agent/status?repo=owner/repo` |
| my bankr tokens / fee tokens | `GET {API}/api/agent/fee-tokens` |
| start vesting / lock tokens on github (web fallback) | `GET {API}/api/agent/setup-link?wallet=0x…` |

See **`AGENT-API.md`** for response fields (`replyText`, `tweetReply`, `links`).

---

## Writes — lock via Bankr chat or X

You **can** lock **any ERC-20 on Base** from terminal or X when the user has a Bankr-linked wallet that can sign transactions.

**There is NO allowlist.** `known-escrow.json` only documents streaming tokens (Space). Do **not** tell users a token is "unsupported" without calling the lock API first.

### Lock flow (mandatory order)

1. **`POST {API}/api/agent/lock`** (always — even when user gives a `0x` address):
   - Header `x-wallet-address: 0x…`
   - Body: `{ "repo": "owner/repo", "token": "TMP", "amount": "855M", "totalPushes": 1 }`
   - `token` = symbol from **wallet holdings**, fee-recipient name, or **`0x` contract address**
   - `amount` = human units (`855000000`, `855M`, `3.49M`)

2. If response has **`installUrl`** → tell user to install GitHub App on that repo, then retry.

3. Submit each item in **`transactions[]`** on Base via Bankr wallet:
   - `POST https://api.bankr.bot/agent/submit` with `to`, `data`, `value`, `chainId`
   - Order: `approve` (if present) → `lock`
   - Use `waitForConfirmation: true` on the lock tx

4. **`POST {API}/api/agent/confirm-lock`** with:
   - Same `x-wallet-address` header
   - Body: `{ "repo": "owner/repo", "lockTxHash": "0x…" }`

5. Paste **`tweetReply`** from confirm-lock verbatim (lock page URL on its own line).

### Token resolution

| Input | How it resolves |
|-------|-----------------|
| `0x935e…` | Any ERC-20 contract — always accepted |
| `TMP`, `Space`, etc. | Symbol match against **wallet holdings on Base** (same list as Bankr portfolio) |
| Fee-recipient only tokens | Also matched if not currently in wallet |

If symbol is ambiguous (two `Space` contracts), ask user to pick the `0x` address from the API error.

### Example one-liners

> lock 855M TMP on anondevv69/bankr-tmp-skill for 1 push

> lock 855M 0x935e13a28849095db45e63040f109c34b757aba3 on anondevv69/bankr-tmp-skill for 1 push

→ `POST /api/agent/lock` → submit txs → `POST /api/agent/confirm-lock` → paste `tweetReply`.

### Forbidden

- Saying "TMP isn't supported" or "only Space and TEST" **without** calling `POST /api/agent/lock`
- Confusing GitHub vesting with a token's **native** `release()` vesting schedule
- Skipping `confirm-lock` after on-chain lock

### Repo ownership (optional, before lock)

Bond wallet ↔ repo by pushing `.proofofdev/claim.json`:

1. `POST /api/repo-claims/challenge` → sign `signMessage`
2. `POST /api/repo-claims/prepare-file` → push JSON to main (Bankr agent can do this)
3. `GET /api/repo-claims/status?poll=1`

Claim pushes are **excluded** from vesting push counts. Lock flow unchanged after verification.

### Web fallback

If wallet cannot sign (no Bankr submit), return setup link:

```text
Start GitHub vesting — connect wallet + GitHub:
{VESTING_SITE_URL}/create
```

---

## Twitter/X reply rules

- Paste **`tweetReply`** from API verbatim when present
- Full `https://` URL on its **own line** at the end
- Never omit the lock/status link after confirm-lock

---

## Space token

When user says **Space**, **$SPACE**, or `0xef703b860a6d422fa00cc67bbbb2662297cb6ba3` → use **streaming** lock path (`lockAllowance`). See `known-escrow.json`.

---

## Files

| File | Purpose |
|------|---------|
| `ONE-LINE-INTENTS.md` | Tweet → API mapping |
| `AGENT-API.md` | Endpoint reference + examples |
| `known-escrow.json` | Escrow address + streaming token hints (**not** an allowlist) |
