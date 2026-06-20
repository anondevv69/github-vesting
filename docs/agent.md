# GitHub Vesting — Agent API

Public agent guide for @bankrbot and Bankr terminals.

**Skill install:**

```text
install GitHub Vesting skill at https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting
```

## Base URL

Set `VESTING_API_URL` to your deployed backend (Railway `SERVER_URL`).

Local dev: `http://localhost:3000`

## Endpoints

| GET | Path | Use |
|-----|------|-----|
| `/api/agent/briefing` | `?wallet=0x…` | Primary tweet reply |
| `/api/agent/grants` | `?wallet=0x…` | Detailed lock list |
| `/api/agent/status` | `?repo=owner/repo` | Single repo progress |
| `/api/agent/setup-link` | `?wallet=0x…` | Start vesting wizard URL |

Header: `x-wallet-address: 0x…` · Optional: `x-client: agent`

## Example

```bash
curl -H "x-wallet-address: 0x…" "$VESTING_API_URL/api/agent/briefing"
```

Response includes `tweetReply` — paste verbatim in X replies.

Full reference: [skills/bankr-vesting/AGENT-API.md](skills/bankr-vesting/AGENT-API.md)
