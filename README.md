# github-vesting

**GitHub-activity-gated token vesting for any ERC-20.**

Lock your ERC-20 tokens in escrow on Base (Robinhood Chain also supported). Earn them back incrementally as you ship verified code — every N pushes to production triggers an on-chain release.

## How it works

1. Fee recipient connects wallet + GitHub OAuth on the setup page
2. Configures a vesting schedule (e.g. 100 total pushes, release every 10)
3. Approves + locks tokens in the `GitEscrow` contract on Base
4. Installs our GitHub App on their repo
5. Every push to `main`/`production` is evaluated:
   - Must target a production branch
   - Must have ≥3 lines of real code changed (raw pushes are estimated at 5 lines per meaningful file; merged PRs are measured on the PR's real diff and credited to the PR author)
   - Bot/App-authored pushes and force-pushes rejected; max 3 counted pushes per day
   - 30-minute cooldown between counted pushes
6. When a milestone is hit → oracle wallet calls `GitEscrow.release()` → tokens sent automatically

**Merge rewards (no lock required):** every *counted* merged PR also pays its
author a flat reward from a pre-funded `ShipRewards` pool — on **any** repo
with the GitHub App installed, whether or not anything is locked (the same
verifier and anti-gaming rules apply). The reward goes to the author's most
recently linked wallet; if none is linked, it **accrues as pending** and pays
out automatically when they link one. Rewards are inert when no pool is
configured for the chain or the per-merge amount is 0.

**Attestation (ship reports):** a developer-side agent can file a ship report
for a commit it shipped (`POST /api/agent/report-ship`) and poll its state
(`reported → confirmed / paid / rejected / expired`). A report is a signal
only — it never moves money; settlement is always the push webhook →
verifier → oracle.

**Agents:** the same API is exposed as an MCP server (stdio locally, or
remote at `https://api.proofofdev.xyz/mcp` once deployed) and as installable
skills for Bankr and Claude — see `mcp/README.md`, `skills/`, and
`docs/agent.md`. Testing: see `TESTING.md`.

---

## Project structure

```
contracts/
  GitEscrow.sol           ERC-20 escrow, oracle-gated release
  ShipRewards.sol         Pre-funded per-counted-merge reward pool (oracle-gated, one payment per merge hash)
  MockERC20.sol           Test token (local/testnet only)
  deploy/                 deployGitEscrow.ts, deployShipRewards.ts, deployMockERC20.ts

src/
  github/
    webhookHandler.ts     Receives + verifies GitHub push webhooks
    pushVerifier.ts       Anti-gaming rules (branch, diff size, rate limits)
    prCredit.ts           Credits merged PRs to the PR author (Ship integration)
    processPush.ts        Shared push → verify → count → release + reward flow
    githubApp.ts          GitHub App client (Octokit)
  oracle/
    releaseOracle.ts      Calls GitEscrow.release on milestone
    shipRewards.ts        Calls ShipRewards.pay on every counted push/merge (grant or grant-less); settles pending accruals on wallet link
  api/
    register.ts           POST /api/vesting/register
    status.ts             GET  /api/vesting/status
    oauth.ts              GitHub OAuth flow
    shipReport.ts         POST /api/agent/report-ship + GET ship-report(s) (attestation)
  lib/
    env.ts                Validated env vars
    redis.ts              Grant storage
    pendingRewards.ts     Pending-reward accrual for unlinked authors
    mcpTools.ts           Shared MCP tool definitions (stdio + remote transports)
  mcpHttp.ts              Remote MCP endpoint (Streamable HTTP, mounted at /mcp)
  index.ts                Express server

frontend/
  src/pages/
    VestingSetupPage.tsx  6-step setup wizard
    VestingDashboardPage.tsx  Wallet dashboard — all locks
    VestingStatusPage.tsx Live push progress dashboard

skills/
  bankr-vesting/          @bankrbot agent skill (SKILL.md + agent API docs)
  claude-vesting/         Claude Code / Muse agent skill (also served by the backend at GET /claude-skill.md)

mcp/
  src/server.ts           MCP server, stdio transport (tools defined in src/lib/mcpTools.ts, shared with the remote /mcp endpoint)
```

---

## Setup

### 1. Create a GitHub App

Go to https://github.com/settings/apps/new and configure:

- **Webhook URL**: `https://your-domain.com/api/webhook/github`
- **Webhook secret**: generate a random string
- **Permissions**: Contents (read), Pull requests (read), Metadata (read)
- **Subscribe to events**: Push

Download the private key and note your App ID, Client ID, Client Secret.

### 2. Deploy the contract

```bash
cp .env.example .env
# fill in ORACLE_PRIVATE_KEY, BASE_RPC_URL, BASESCAN_API_KEY
npm install
npm run compile:contracts
npm run deploy:base-sepolia   # testnet first
# copy the deployed address into GIT_ESCROW_ADDRESS in .env
```

### 3. Run the bot service

```bash
# fill in all .env values
npm run dev
```

### 4. Run the frontend

```bash
cd frontend
npm install
# copy .env.example → .env and set VITE_API_URL, VITE_GIT_ESCROW_ADDRESS
npm run dev
```

---

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/vesting/register` | Register a new vesting grant |
| `GET`  | `/api/vesting/grants?recipient=0x…` | Grants for a wallet |
| `GET`  | `/api/vesting/status?repo=owner/repo` | Get grant progress |
| `GET`  | `/api/vesting/list` | List all active grants |
| `POST` | `/api/webhook/github` | GitHub push webhook |
| `POST` | `/api/webhook/gitlawb` | GitLawb push webhook |
| `GET`  | `/api/oauth/github` | Begin GitHub OAuth |
| `GET`  | `/api/oauth/github/callback` | OAuth callback |

### Bankr agent API (@bankrbot skill)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agent/briefing?wallet=0x…` | Tweet-friendly summary (`tweetReply`) |
| `GET` | `/api/agent/grants?wallet=0x…` | Detailed grants for linked wallet |
| `GET` | `/api/agent/status?repo=owner/repo` | Single-repo progress |
| `GET` | `/api/agent/setup-link?wallet=0x…` | Setup wizard URL |
| `GET` | `/api/agent/fee-tokens` | Wallet ERC-20 holdings on Base (any lockable token) |
| `POST` | `/api/agent/lock` / `/api/agent/prepare-lock` | Prepare approve+lock transactions (unsigned) |
| `POST` | `/api/agent/confirm-lock` | Register a grant after the on-chain lock |
| `POST` | `/api/agent/link-github` | Create a one-time wallet↔GitHub magic link |
| `POST` | `/api/agent/report-ship` | File a ship report (attestation signal only) |
| `GET` | `/api/agent/ship-report` / `/api/agent/ship-reports` | Ship-report state(s) |
| `GET` | `/api/dev/link-wallet/:login` | Linked wallets + `pendingRewards[]` / `pendingRewardsTotal` |

Header: `x-wallet-address: 0x…` (optional alternative to query param).

Also served by the backend: `GET /agent.md` (agent protocol doc),
`GET /claude-skill.md` (Claude skill), and the MCP endpoint at `/mcp`
(Streamable HTTP; see `mcp/README.md`).

Skill package: [`skills/bankr-vesting/`](skills/bankr-vesting/SKILL.md)

---

## Deploy (Railway + Vercel)

- **[docs/RAILWAY.md](docs/RAILWAY.md)** — backend + Redis + GitHub webhook
- **[docs/VERCEL.md](docs/VERCEL.md)** — frontend wizard + dashboard
- **[docs/GITLAWB.md](docs/GITLAWB.md)** — GitLawb agent repos + webhooks
- **[docs/agent.md](docs/agent.md)** — Bankr agent API

After deploy, update `skills/bankr-vesting/skill-manifest.json` with your public `apiBaseUrl` and `defaultSiteUrl`.

---

## Anti-gaming rules

| Rule | Value |
|------|-------|
| Target branch | `main`, `master`, `production`, `prod` |
| Min meaningful lines/push | 3 (estimated from code files) |
| Max counted pushes/day | 3 |
| Cooldown between pushes | 30 minutes (from last **counted** push) |
| Substantial fix bypass | ~50+ estimated lines of code can count inside cooldown |
| Force-push | Rejected (doesn't count) |
| Lock-files / docs only | Rejected (doesn't count) |

---

## Smart contract

`GitEscrow.sol` on Base (EVM):

```solidity
lock(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile)
lockAllowance(...)   // same params — streaming mode for transfer-restricted tokens (e.g. Bankr DERC20): tokens stay in the recipient's wallet, pulled per milestone
lockWithPermit(...)  // lock params + EIP-2612 permit signature — streaming mode for tokens that block approve()
release(bytes32 repoId, uint256 totalVerifiedPushes)   // oracle only
cancel(bytes32 repoId)                                  // recipient only — reclaim remaining (pre-funded grants only; streaming grants hold nothing in escrow)
```

Schedules must divide evenly: `totalPushes % pushesPerMile == 0` (enforced on-chain). Per-milestone amount is `amount / (totalPushes / pushesPerMile)` (integer division); any rounding dust is released with the final milestone.

`repoId` = `keccak256("owner/repo")` — use `encodeRepoId("owner/repo")` on-chain to get it.
