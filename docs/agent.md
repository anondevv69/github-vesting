# GitHub Vesting — Agent API

Public guide for bots and terminals integrating with GitHub vesting.

**Site:** `https://www.proofofdev.xyz`  
**API:** `https://api.proofofdev.xyz`

---

## Pick your integration path

| Path | Who | What you need |
|------|-----|---------------|
| **Bankr skill** | @bankrbot, Bankr CLI, Bankr terminals | Install skill package (below) |
| **Regular agent** | Custom bots, OpenClaw, scripts, any HTTP client | Call REST endpoints directly (below) |

Both paths use the same Agent API. The Bankr skill adds intent routing, tweet formatting, and setup-link rules.

---

## Bankr agents (@bankrbot)

For Bankr-managed agents that support skill install:

```text
install GitHub Vesting skill at https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting
```

**Skill folder:** [skills/bankr-vesting/](https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting)

### Routing (mandatory for Bankr)

```
if message mentions github vesting / lock tokens / vesting progress / verified pushes:
  1. use_skill("bankr-vesting")
  2. Read ONE-LINE-INTENTS.md
  3. Resolve linked wallet → x-wallet-address header
  4. Call Agent API BEFORE replying
  5. Paste tweetReply verbatim — URL on its own line
```

### Bankr-specific rules

- Paste **`tweetReply`** from the API verbatim in X replies
- **Lock via chat:** `POST /api/agent/lock` → Bankr `agent/submit` on Base → `POST /api/agent/confirm-lock`
- Web fallback for locks: `{SITE}/create`
- Status links: `{SITE}/lock/{owner}/{repo}`
- Space token → streaming lock path (allowance, not escrow)

Full skill docs: `SKILL.md`, `AGENT-API.md`, `ONE-LINE-INTENTS.md` in the skill folder.

---

## Regular agents (any HTTP client)

No skill install required. Call the public Agent API directly.

### Base URL

```
https://api.proofofdev.xyz
```

Local dev: `http://localhost:3000`

Set env `VESTING_API_URL` to your backend URL.

### Authentication

Public read endpoints. Pass the user's wallet:

- Query: `?wallet=0x…`
- Header: `x-wallet-address: 0x…` (preferred)

Optional: `x-client: agent`

### Endpoints

| GET | Path | Use |
|-----|------|-----|
| `/api/agent/briefing` | `?wallet=0x…` | Summary of all locks for a wallet |
| `/api/agent/grants` | `?wallet=0x…` | Detailed grant list |
| `/api/agent/status` | `?repo=owner/repo` | Single repo progress |
| GET | `/api/agent/setup-link` | `?wallet=0x…` | URL to start a new lock (web) |
| GET | `/api/agent/fee-tokens` | `x-wallet-address` | Wallet ERC-20 holdings on Base (any lockable token) |
| POST | `/api/agent/lock` | body + wallet header | Prepare approve+lock txs + instructions |
| POST | `/api/agent/confirm-lock` | `repo`, `lockTxHash` | Register grant after on-chain lock |

### Example

```bash
curl -H "x-wallet-address: 0x…" \
  "https://api.proofofdev.xyz/api/agent/briefing"
```

**Response fields:**

- `replyText` — human-readable summary with lock page URL
- `tweetReply` — same text, formatted for X (Bankr agents use this)
- `links.setup` — `{SITE}/create`
- `links.primaryStatus` — `{SITE}/lock/owner/repo`

### Site URLs returned by the API

| Link | Path |
|------|------|
| Create lock | `/create` |
| Explore | `/` |
| Lock status | `/lock/{owner}/{repo}` |
| Dev profile | `/dev/{username}` |

### Writes (lock via agent)

Bankr agents with wallet signing — **any ERC-20 on Base** (TMP, Space, USDC, or any `0x` address):

1. `POST /api/agent/lock` with `repo`, `token`, `amount`, `totalPushes`
2. Submit `transactions[]` via `https://api.bankr.bot/agent/submit` on Base
3. `POST /api/agent/confirm-lock` with `lockTxHash`
4. Reply with `tweetReply` from confirm-lock

Web fallback (no wallet signing):

```
Start GitHub vesting:
https://www.proofofdev.xyz/create
```

---

## Health check

```bash
curl https://api.proofofdev.xyz/health
```

Returns `{ "ok": true, "service": "github-vesting" }`.

---

## Full reference

- Bankr skill API details: [skills/bankr-vesting/AGENT-API.md](https://github.com/anondevv69/github-vesting/blob/main/skills/bankr-vesting/AGENT-API.md)
- Human-facing rules: [Help](/help) on the site
