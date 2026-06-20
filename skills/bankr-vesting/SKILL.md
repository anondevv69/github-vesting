# GitHub Vesting — Bankr agent skill

Lock Bankr ERC-20 tokens (e.g. **Space**) on Base. Earn them back by shipping verified commits to a GitHub repo.

**Site:** `{VESTING_SITE_URL}` (frontend wizard + dashboard)  
**API:** `{VESTING_API_URL}` (agent + webhooks)

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

Example: **2 total pushes**, **2 per milestone** → **1 milestone** → full amount releases after **2 verified pushes**.

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
| start vesting / lock tokens on github | `GET {API}/api/agent/setup-link?wallet=0x…` |

See **`AGENT-API.md`** for response fields (`replyText`, `tweetReply`, `links`).

---

## Writes (approve + lock on-chain)

**Cannot be done by tweet alone** — reply with setup link from `setup-link` or `briefing`:

```text
Start GitHub vesting — connect wallet + GitHub:
{VESTING_SITE_URL}/vesting/setup
```

Steps: connect wallet → GitHub OAuth → repo + token + schedule → approve + lock on Base → install GitHub App → activate.

Dashboard: `{VESTING_SITE_URL}/vesting/dashboard`

---

## Twitter/X reply rules

- Paste **`tweetReply`** from API verbatim when present
- Full `https://` URL on its **own line** at the end
- Never omit the setup/status link

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
