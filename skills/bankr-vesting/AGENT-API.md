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

Link to start a new vesting lock (web wizard fallback).

```http
GET {API}/api/agent/setup-link?wallet=0x…
```

**Response:** `setupUrl`, `dashboardUrl`, `tweetReply`, `steps[]`.

---

## GET /api/agent/fee-tokens

Tokens the wallet can lock on Base — **wallet holdings** (same idea as Bankr portfolio) plus fee-recipient tokens.

```http
GET {API}/api/agent/fee-tokens
x-wallet-address: 0x…
```

**Response:** `tokens[]`, `walletHoldings[]`, `replyText`, `tweetReply`.

**Any ERC-20 on Base works** — pass a `0x` address to `POST /api/agent/lock` even if not listed here.

---

## POST /api/launch/verify-github — ALWAYS FIRST for any write

Obtain the session's `verificationToken` before lock / confirm-lock /
onboard / prepare-launch. All three body fields are required.

```http
POST {API}/api/launch/verify-github
Content-Type: application/json

{
  "githubLogin": "their-login",
  "repo": "owner/repo",
  "wallet": "0x…",
  "chain": "base"
}
```

**Response (200):** `{ "ok": true, "verified": true, "verificationToken": "…", "expiresAt": "…" }` — token lives ~15 min, bound to login+repo+wallet+chain.

**Refusals (fix by `code`, then re-verify):** `LAUNCH_VERIFY_BAD_INPUT` (a required field is missing) · `LAUNCH_APP_NOT_INSTALLED` / `LAUNCH_APP_NO_ACCESS` (user installs the app: `https://github.com/apps/bankr-vesting/installations/new`) · `LAUNCH_NOT_OWNER_OR_ADMIN` · `LAUNCH_WALLET_NOT_LINKED` (`POST /api/agent/link-github` `{wallet, githubLogin}` → user opens the returned `linkUrl` once). Without a token, lock/prepare/confirm return 403 `LAUNCH_VERIFICATION_REQUIRED` — never resend the same call; verify instead.

---

## POST /api/agent/lock

Prepare lock transactions + Bankr execution instructions (one-shot).

```http
POST {API}/api/agent/lock
Content-Type: application/json
x-wallet-address: 0x…

{
  "repo": "owner/repo",
  "token": "Space",
  "amount": "3.49M",
  "totalPushes": 10,
  "pushesPerMilestone": 10,
  "verificationToken": "<token from verify-github, this session>"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `repo` | yes | `owner/name` on GitHub |
| `token` | yes | Symbol from wallet (`TMP`, `Space`), or any `0x` ERC-20 on Base |
| `amount` | yes | Human units: `3490000`, `3.49M`, `1.5K` |
| `totalPushes` | no | Default `10` |
| `pushesPerMilestone` | no | Default = `totalPushes` (single release). **This exact field name is the only milestone control** — `releasesPerMilestone` is not a request field (it is only the on-chain `Locked` event's parameter name) and is silently ignored if sent |
| `verificationToken` | **yes** | From `POST /api/launch/verify-github` in this session; without it the call returns 403 `LAUNCH_VERIFICATION_REQUIRED` |

**Response (200):**

```json
{
  "ok": true,
  "transactions": [
    { "step": "approve", "to": "0x…", "data": "0x…", "value": "0x0", "chainId": 8453 },
    { "step": "lock", "to": "0x71A9…", "data": "0x…", "value": "0x0", "chainId": 8453 }
  ],
  "bankrSubmitUrl": "https://api.bankr.bot/wallet/submit",
  "confirmUrl": "https://api.proofofdev.xyz/api/agent/confirm-lock",
  "statusUrl": "https://www.proofofdev.xyz/lock/owner/repo",
  "tweetReply": "…",
  "steps": ["Submit each transaction…", "POST confirm-lock…"]
}
```

**Response (400, GitHub App missing):** `installUrl`, `tweetReply` with install link.

---

## POST /api/agent/prepare-lock

Same as `/api/agent/lock` without the extra `steps` wrapper. Use when you already know the Bankr submit flow.

The response also carries `escrowVersion` (the escrow the prepared transactions target — `3` is the current multi-grant escrow) and `expectedGrantId` (advisory: the grantId the lock will receive if no other lock for the repo lands first).

---

## POST /api/agent/confirm-lock

Register the grant after the lock transaction confirms on Base.

```http
POST {API}/api/agent/confirm-lock
Content-Type: application/json
x-wallet-address: 0x…

{
  "repo": "owner/repo",
  "lockTxHash": "0x…",
  "verificationToken": "<FRESH token — re-run verify-github first>"
}
```

Parses the `Locked` event from the tx, verifies recipient matches wallet, registers push tracking. An optional `grantId` in the body is cross-checked against the event — a mismatch is a hard error.

**Response:** `grant` (including the recorded `grantId` for V3 locks), `grantId`, `statusUrl`, `tweetReply` (paste verbatim on X). Per-grant status: `GET {API}/api/vesting/grant/{grantId}`.

---

## Bankr wallet submit (after prepare/lock)

For each transaction in `transactions[]`, in order:

```http
POST https://api.bankr.bot/wallet/submit
```

Legacy `/agent/submit` is **removed** (returns 403) — do not use it. The prepare-lock response's `bankrSubmitUrl` field names the current `/wallet/submit` route (fixed 2026-11-23, audit H4).

Use fields `to`, `data`, `value`, `chainId` from the prepare response. Set `waitForConfirmation: true` on the final lock tx.

Then call `confirm-lock` with the lock transaction hash.

---

## POST /api/agent/link-github

Create a one-time magic link to bind the Bankr wallet to a GitHub dev profile.

```http
POST {API}/api/agent/link-github
Content-Type: application/json
x-wallet-address: 0x…

{ "githubLogin": "anondevv69" }
```

**Response (200):**

```json
{
  "ok": true,
  "wallet": "0x…",
  "githubLogin": "anondevv69",
  "linkUrl": "https://www.proofofdev.xyz/link-github?t=…",
  "profileUrl": "https://www.proofofdev.xyz/dev/anondevv69",
  "expiresAt": "2026-06-24T…",
  "replyText": "Link GitHub @anondevv69…",
  "tweetReply": "…"
}
```

Paste `linkUrl` in DM only (expires in 15 minutes). User opens link → GitHub OAuth as that username → wallet appears on dev profile.

## GET /api/link-github/inspect

Landing page validation (not for agents — used by `/link-github` UI).

```http
GET {API}/api/link-github/inspect?t=…
```

---

## POST /api/repo-claims/challenge

Start repo ownership verification (wallet ↔ repo bond).

```http
POST {API}/api/repo-claims/challenge
x-wallet-address: 0x…

{ "repo": "owner/repo" }
```

Returns `signMessage`, `claimId`, `filePath`, `fileTemplate`.

## POST /api/repo-claims/prepare-file

After wallet signs `signMessage`:

```http
POST {API}/api/repo-claims/prepare-file

{ "claimId": "clm_…", "signature": "0x…" }
```

Returns `fileContent` to commit at `.proofofdev/claim.json` on `main`. Push via git or Bankr agent — **does not count as a vesting push**.

## GET /api/repo-claims/status

```http
GET {API}/api/repo-claims/status?repo=owner/repo&wallet=0x…&poll=1
```

Returns `verified`, `claim`, `tweetReply`.

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

---

## Merge rewards (ShipRewards) — no lock required

Every **counted** merged PR pays its author a flat per-merge reward from a
pre-funded pool — on any repo with the GitHub App installed, **with or
without a vesting grant** (same verifier / anti-gaming rules as vesting).
The reward goes to the author's **most recently linked** wallet, keyed
on-chain by merge commit hash (never payable twice). If the author has no
linked wallet, the reward **accrues as pending** at the earn-time amount
and pays out automatically when a wallet is linked — no claim step.

Read state (no auth):

```http
GET {API}/api/dev/link-wallet/<github-login>
```

Returns `wallets[]` plus `pendingRewards[]` (`{repoId, repoFullName,
mergeSha, amount, chain, earnedAt}`) and `pendingRewardsTotal` (wei).
Rewards are inert when the server has no pool configured for the chain or
the per-merge amount is 0: merges still count, nothing pays or accrues.
Ship-report endpoints (`POST /api/agent/report-ship`, `GET
/api/agent/ship-report(s)`) are documented in `docs/agent.md`.
