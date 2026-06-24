# Agent API reference

Base URL: `{API}` = production `SERVER_URL` (e.g. `https://api.proofofdev.xyz`) or `http://localhost:3000` for dev.

Site URLs in agent responses use `{VESTING_SITE_URL}` (e.g. `https://www.proofofdev.xyz`):

| Link | Path |
|------|------|
| Create lock | `/create` |
| Explore | `/` |
| Lock status | `/lock/{owner}/{repo}` |
| Dev profile | `/dev/{username}` |

## Authentication

Public read endpoints. Pass the user's linked wallet:

- Query: `?wallet=0x…`
- Header: `x-wallet-address: 0x…` (preferred for agents)

Optional: `x-client: agent`

---

## GET /api/agent/briefing

Summary of all vesting locks for a wallet. **Primary endpoint for @bankrbot.**

```http
GET {API}/api/agent/briefing?wallet=0x…
x-wallet-address: 0x…
x-client: agent
```

**Response (200):**

```json
{
  "ok": true,
  "wallet": "0x…",
  "grantCount": 1,
  "grants": [{ "repoFullName": "owner/repo", "status": "active", "progress": { … } }],
  "replyText": "GitHub vesting — 1 lock\n\nowner/repo — active …\n\nhttps://…/lock/owner/repo",
  "tweetReply": "…same as replyText…",
  "links": { "setup": "…/create", "dashboard": "…/", "primaryStatus": "…/lock/owner/repo" }
}
```

**Tweet:** paste `tweetReply` verbatim.

---

## GET /api/agent/grants

Detailed grant list (same wallet resolution as briefing).

```http
GET {API}/api/agent/grants?wallet=0x…
```

Returns `grants[]` with `progress`, `recentPushes`, formatted token amounts, URLs.

---

## GET /api/agent/status

Progress for a single repo.

```http
GET {API}/api/agent/status?repo=owner/repo
```

**Response:** `grant`, `progress`, `recentPushes`, `replyText`, `tweetReply`, `links.status` (lock page URL).

---

## GET /api/agent/setup-link

Link to start a new vesting lock.

```http
GET {API}/api/agent/setup-link?wallet=0x…
```

**Response:** `setupUrl`, `dashboardUrl`, `tweetReply`, `steps[]`.

---

## Web (non-agent) endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/vesting/register` | Activate after on-chain lock |
| GET | `/api/vesting/status?repo=owner/repo` | Grant progress (legacy JSON) |
| GET | `/api/vesting/lock/:owner/:repoName` | Lock page payload (status + token + pushes) |
| GET | `/api/vesting/search?q=…` | Unified search (dev / repo / token) |
| GET | `/api/vesting/recent-pushes` | Last 10 verified pushes (explore feed) |
| GET/PATCH | `/api/vesting/dev-profile/:login` | Dev profile fields |
| GET | `/api/github/repo?repo=owner/repo` | Repo validation (create flow) |
| GET | `/api/vesting/grants?recipient=0x…` | Wallet grants (JSON) |
| POST | `/api/webhook/github` | GitHub App push webhooks |

---

## Health

```http
GET {API}/health
```

Returns `{ "ok": true, "service": "github-vesting" }`.
