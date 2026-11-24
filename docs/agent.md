# GitHub Vesting — Agent API

Public guide for bots and terminals integrating with GitHub vesting.

**Site:** `https://www.proofofdev.xyz`  
**API:** `https://api.proofofdev.xyz`

---

## Pick your integration path

| Path | Who | What you need |
|------|-----|---------------|
| **Bankr skill** | @bankrbot, Bankr CLI, Bankr terminals | Install skill package (below) |
| **Claude skill** | Claude Code, Muse agents | Install skill package (below) |
| **Regular agent** | Custom bots, OpenClaw, scripts, any HTTP client | Call REST endpoints directly (below) |

All paths use the same Agent API. The Bankr skill adds intent routing, tweet formatting, and setup-link rules.

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
- **Lock via chat:** `POST /api/agent/lock` → Bankr `POST /wallet/submit` on Base (legacy `/agent/submit` is removed) → `POST /api/agent/confirm-lock`
- Web fallback for locks: `{SITE}/create`
- Status links: `{SITE}/lock/{owner}/{repo}`
- Space token → streaming lock path (allowance, not escrow)

Full skill docs: `SKILL.md`, `AGENT-API.md`, `ONE-LINE-INTENTS.md` in the skill folder.

---

## Claude agents (Claude Code / Muse)

Install the Claude skill — same Agent API, with Claude-specific signing routes (own wallet tooling, Bankr, or human hand-off; Claude has no built-in wallet). The backend serves the skill itself, no code host required:

```text
download https://api.proofofdev.xyz/claude-skill.md into your skills directory as claude-vesting/SKILL.md (e.g. ~/.claude/skills/claude-vesting/SKILL.md)
```

**Skill source in repo:** `skills/claude-vesting/SKILL.md`

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

| Method | Path | Params | Use |
|--------|------|--------|-----|
| GET | `/api/agent/briefing` | `?wallet=0x…` | Summary of all locks for a wallet |
| GET | `/api/agent/grants` | `?wallet=0x…` | Detailed grant list |
| GET | `/api/agent/status` | `?repo=owner/repo` | Single repo progress |
| GET | `/api/agent/setup-link` | `?wallet=0x…` | URL to start a new lock (web) |
| GET | `/api/agent/fee-tokens` | `x-wallet-address` | Wallet ERC-20 holdings on Base (any lockable token) |
| POST | `/api/agent/lock` | body + wallet header | Prepare approve+lock txs + instructions |
| POST | `/api/agent/prepare-lock` | body + wallet header | Same as `/api/agent/lock` without the extra `steps` wrapper |
| POST | `/api/agent/confirm-lock` | `repo`, `lockTxHash` | Register grant after on-chain lock |
| POST | `/api/agent/link-github` | body (`githubLogin`) + wallet header | Create a one-time magic link binding the wallet to a GitHub dev profile |
| POST | `/api/agent/report-ship` | body (`repo`, `headSha`, optional `prNumber`, `authorLogin`) | File a ship report (attestation) for a shipped/merged commit |
| GET | `/api/agent/ship-report` | `?repo=owner/repo&sha=<headSha>` | Current state of one ship report |
| GET | `/api/agent/ship-reports` | `?repo=owner/repo` | Recent ship reports for a repo (newest first, cap 20) |

**Ship reports (attestation layer):** a ship report is a developer-side
agent's claim that it shipped a commit — a signal for instant feedback,
**never** a settlement. Reports are unauthenticated by design (they are
worthless to fake): a report alone never releases tokens and never
influences the verifier. Settlement is only ever the GitHub push webhook →
verifier → oracle. The webhook resolves a matching report to `confirmed`
(counted, no payout on that push), `paid` (release and/or merge-reward tx
hashes on the record), or `rejected` (with the verifier's reason); a report
with no webhook within 24h reads as `expired`. Every report response
carries `"settlement": "github-webhook"` and `"reportMovesMoney": false`.

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

1. `POST /api/agent/lock` with `repo`, `token`, `amount`, `totalPushes` (optional: `pushesPerMilestone`, `chain` — `base` default, `robinhood`, `base-sepolia`)
2. Submit `transactions[]` via `https://api.bankr.bot/wallet/submit` on Base (legacy `/agent/submit` is removed and returns 403)
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

Returns `{ "ok": true, "service": "github-vesting", "configured": true, "ts": "…" }` — `configured: false` plus a `missingEnv` list when required env vars are unset.

---

## Full reference

- Bankr skill API details: [skills/bankr-vesting/AGENT-API.md](https://github.com/anondevv69/github-vesting/blob/main/skills/bankr-vesting/AGENT-API.md)
- Human-facing rules: [Help](/help) on the site
