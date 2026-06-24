---
name: bankr-vesting
description: Lock Bankr tokens on GitHub repos via verified pushes — status, fee tokens, and full lock flow from chat or X.
tags: [github, vesting, bankr, base, defi, space]
---

# GitHub Vesting — Bankr agent skill

Lock Bankr ERC-20 tokens (e.g. **Space**) on Base. Earn them back by shipping verified commits to a GitHub repo.

**Site:** `{VESTING_SITE_URL}` (explore, lock pages, dev profiles, create flow)  
**API:** `{VESTING_API_URL}` (agent + webhooks)

| Page | Path |
|------|------|
| Explore (search) | `/` |
| Lock status + token | `/lock/{owner}/{repo}` |
| Dev profile | `/dev/{username}` |
| Create lock | `/create` |

Override via env: `VESTING_SITE_URL`, `VESTING_API_URL` (defaults in `skill-manifest.json` until you deploy).

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

You **can** lock tokens from terminal or X when the user has a Bankr-linked wallet that can sign Base transactions.

### Lock flow (mandatory order)

1. **`POST {API}/api/agent/lock`** (or `prepare-lock`) with:
   - Header `x-wallet-address: 0x…`
   - Body: `{ "repo": "owner/repo", "token": "Space", "amount": "3.49M", "totalPushes": 10 }`
   - `token` = symbol (`Space`), name, or `0x` address
   - `amount` = human units (`3490000`, `3.49M`, `1.5K`)

2. If response has **`installUrl`** → tell user to install GitHub App on that repo, then retry.

3. Submit each item in **`transactions[]`** on Base via Bankr wallet:
   - `POST https://api.bankr.bot/agent/submit` with `to`, `data`, `value`, `chainId`
   - Order: `approve` (if present) → `lock`
   - Use `waitForConfirmation: true` on the lock tx

4. **`POST {API}/api/agent/confirm-lock`** with:
   - Same `x-wallet-address` header
   - Body: `{ "repo": "owner/repo", "lockTxHash": "0x…" }`

5. Paste **`tweetReply`** from confirm-lock verbatim (lock page URL on its own line).

### Example one-liner

> lock 3.49M Space on anondevv69/my-repo for 10 pushes

→ `POST /api/agent/lock` → submit txs → `POST /api/agent/confirm-lock` → paste `tweetReply`.

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
| `known-escrow.json` | Escrow address + supported tokens |
