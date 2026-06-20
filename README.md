# github-vesting

**GitHub-activity-gated token vesting for Bankr tokens.**

Lock your ERC-20 tokens in escrow on Base. Earn them back incrementally as you ship verified code — every N pushes to production triggers an on-chain release.

## How it works

1. Fee recipient connects wallet + GitHub OAuth on the setup page
2. Configures a vesting schedule (e.g. 100 total pushes, release every 10)
3. Approves + locks tokens in the `GitEscrow` contract on Base
4. Installs our GitHub App as a collaborator on their repo
5. Every push to `main`/`production` is evaluated:
   - Must target a production branch
   - Must have ≥10 lines of real code changed
   - Force-pushes rejected; max 3 counted pushes per day
   - 30-minute cooldown between counted pushes
6. When a milestone is hit → oracle wallet calls `GitEscrow.release()` → tokens sent automatically

---

## Project structure

```
contracts/
  GitEscrow.sol           ERC-20 escrow, oracle-gated release
  deploy/deployGitEscrow.ts

src/
  github/
    webhookHandler.ts     Receives + verifies GitHub push webhooks
    pushVerifier.ts       Anti-gaming rules (branch, diff size, rate limits)
    githubApp.ts          GitHub App client (Octokit)
  oracle/
    releaseOracle.ts      Calls GitEscrow.release on milestone
  api/
    register.ts           POST /api/vesting/register
    status.ts             GET  /api/vesting/status
    oauth.ts              GitHub OAuth flow
  lib/
    env.ts                Validated env vars
    redis.ts              Grant storage
  index.ts                Express server

frontend/
  src/pages/
    VestingSetupPage.tsx  6-step setup wizard
    VestingDashboardPage.tsx  Wallet dashboard — all locks
    VestingStatusPage.tsx Live push progress dashboard

skills/
  bankr-vesting/          @bankrbot agent skill (SKILL.md + agent API docs)
```

---

## Setup

### 1. Create a GitHub App

Go to https://github.com/settings/apps/new and configure:

- **Webhook URL**: `https://your-domain.com/api/webhook/github`
- **Webhook secret**: generate a random string
- **Permissions**: Contents (read), Metadata (read)
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

Header: `x-wallet-address: 0x…` (optional alternative to query param).

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
Anti-gaming rules in README - update MIN_LINES to 50
| Max counted pushes/day | 3 |
| Cooldown between pushes | 30 minutes |
| Force-push | Rejected (doesn't count) |
| Lock-files / docs only | Rejected (doesn't count) |

---

## Smart contract

`GitEscrow.sol` on Base (EVM):

```solidity
lock(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile)
release(bytes32 repoId, uint256 totalVerifiedPushes)   // oracle only
cancel(bytes32 repoId)                                  // recipient only — reclaim remaining
```

`repoId` = `keccak256("owner/repo")` — use `encodeRepoId("owner/repo")` on-chain to get it.
