# Testing Proof of Dev — tester guide

*Last updated 2026-11-23. Everything on branch `ship/pr-credit-and-rewards`
is built and locally verified; nothing is deployed yet. This file answers
two questions: what can be tested **today**, and what has to happen before
**external** testers can touch it.*

---

## 1. What works today — no deploy needed

The full stack runs locally: a Hardhat chain (chainId 8453), a fake-Redis
stub, a fixture GitHub API, and the real backend + contracts from this
repo. Each E2E driver boots the whole stack, runs its scenario, and tears
down. Run from the repo root:

| Driver | Proves |
|---|---|
| `tests/e2e/run-e2e.sh` | The core loop: a counted push releases a milestone tranche on-chain (500 of 1,000 test tokens); a docs-only push is rejected and moves nothing; a second counted push completes vesting; the per-merge reward pays exactly once (a second payment attempt reverts). |
| `tests/e2e/run-pr-credit.sh` | PR-credit: a human's squash-merged PR is credited to the **PR author** with real line counts (milestone + reward in the same webhook flow); a bot-authored PR (dependabot) is rejected and earns nothing. |
| `tests/e2e/run-attestation.sh` | Ship reports: report → `paid` with release + reward tx hashes on the record; docs-only → `rejected` with the verifier's reason; a 25h-old report reads `expired`; malformed report bodies → 400; a report filed **after** its push reconciles at creation (counted → `confirmed`, rejected → `rejected`). |
| `tests/e2e/run-rewards.sh` | Grant-less rewards + accrual: a counted merge on a repo with **no lock** pays the author and appears in the recent-pushes feed; an **unlinked** author's reward accrues as pending and pays out in full when they link a wallet (real signature link flow); re-link + webhook replay never double-pays. |
| `tests/e2e/run-mcp-remote.sh` | The remote MCP endpoint: HTTP initialize + tools/list + a real `vesting_status` call against the seeded backend; malformed requests get JSON-RPC errors (not HTML); the stdio server still passes its own smoke; both transports expose identical tool lists. |

Also usable today, against a locally running backend:

- **Stdio MCP server** — `cd mcp && npm install`, then
  `claude mcp add proofofdev -- npx tsx "$PWD/mcp/src/server.ts"` with
  `POD_API_URL=http://127.0.0.1:3210` (or wherever the backend runs).
  Smoke client: `mcp/smoke.mjs`. See `mcp/README.md`.
- **The Claude skill** — `skills/claude-vesting/SKILL.md` (the same file
  the backend serves at `GET /claude-skill.md`), including the Claude
  Code push-hook assets under `skills/claude-vesting/hooks/`.
- **The Bankr skill** — `skills/bankr-vesting/` (docs only; live use
  needs the deployed API + a Bankr wallet).

## 2. Go-live checklist — what external testers need

In order. The authoritative runbook is
`~/workspace/claude-ship/railway-deploy/DEPLOY.md`; the GitHub App step is
`~/workspace/claude-ship/railway-deploy/APP-MANIFEST.md`.

1. **Push the branch** `ship/pr-credit-and-rewards` to GitHub.
   ⚠️ The stored GitHub PAT is dead (401) — push via a signed-in browser
   session or a refreshed PAT.
2. **Railway backend + Redis** — recreate the service (direct tarball
   upload per DEPLOY.md; the old project was deleted), attach Redis,
   set every env var from DEPLOY.md §3 / `.env.example` (including
   `GIT_ESCROW_SEPOLIA_ADDRESS`, `SHIP_REWARDS_ADDRESS`,
   `SHIP_REWARDS_ROBINHOOD_ADDRESS`, `SHIP_REWARD_PER_MERGE`).
3. **Fresh GitHub App via manifest** — one-click creation from
   `app-manifest.json` (read-only permissions: Contents, Pull requests,
   Metadata; push webhook), convert the returned code with
   `convert-app-manifest.sh`, put the credentials in Railway env.
4. **DNS** — point `api.proofofdev.xyz` at the Railway service; repoint
   the App webhook to `https://api.proofofdev.xyz/api/webhook/github`.
5. **Post-deploy checks** (DEPLOY.md §6) — health, status API against a
   seeded grant, and the remote MCP smoke
   (`MCP_URL=https://api.proofofdev.xyz/mcp node mcp/smoke-http.mjs …`).
6. **Base Sepolia proof** — deploy the escrows to Sepolia, make a small
   throwaway lock, merge a real PR, watch it count + release.
7. **Pilot** — one real repo, observe-mode Claude Ship policy if Ship is
   being tested, small real lock on Base mainnet.

Until steps 1–5 land, `https://api.proofofdev.xyz` (and therefore the
remote MCP link, the served skill, and both agent skills) does not
answer — the frontend at www.proofofdev.xyz is up, the API is not.

## 3. Tester journey (once live)

1. **Install the GitHub App** on a test repo (the install link is
   returned by the lock-prepare flow, or via the site).
2. **Pick a path:**
   - **Option A — with a lock:** prepare a lock via the site, the Claude
     skill, or the agent API (`POST /api/agent/lock` → sign the returned
     transactions → `POST /api/agent/confirm-lock`). Use a throwaway
     test token and a short schedule (e.g. 10 pushes, release every 2).
   - **Option B — grant-less:** skip the lock entirely. Counted merges
     still earn the per-merge reward.
3. **Link a wallet** to your GitHub login (site flow, magic link, or the
   signature flow in the skill) — or deliberately *don't*, to test
   accrual (step 5).
4. **Merge a real PR** into `main`/`master`/`production`/`prod` — by
   hand, or via `/ship` if you're testing Claude Ship. Docs-only,
   bot-authored, and `.claude/`/`.github/`-only changes correctly earn
   nothing; ≥3 meaningful lines, ≤3 counted pushes/day, 30-min cooldown
   (50+ lines bypasses the cooldown).
5. **Watch the state, in any of these places:**
   - Status API: `GET /api/agent/status?repo=owner/repo` — push counter,
     next milestone, grant status.
   - Ship report: file one (`POST /api/agent/report-ship` or let the
     Claude Code hook do it) and poll `GET /api/agent/ship-report` —
     `reported → confirmed / paid / rejected / expired`; `paid` carries
     the release and/or reward tx hashes.
   - MCP: `vesting_status`, `ship_report`, `repo_recent_pushes` tools
     (remote URL or stdio).
   - Accrual: `GET /api/dev/link-wallet/<your-login>` — before linking
     you should see `pendingRewards[]` grow; after linking, the backlog
     pays out and the list empties. On-chain: the tranche/reward lands
     in the recipient wallet (check on Basescan / blockscout).
6. **File what you find** (see §5).

## 4. Known unproven — read before trusting a result

These are **not** covered by the local suites; a failure here is a
finding, not a surprise:

- **Live-fire against real api.github.com.** PARTIALLY PROVEN
  2026-11-24: the raw-push webhook path ran live end to end — real
  pushes to anondevv69/pod-test were delivered by GitHub, signature-
  verified, counted by the verifier (total verified pushes = 1), and
  two follow-ups were correctly rejected by the 30-minute cooldown.
  Still fixture-only: PR-credit, installation lookup, file reads.
- **Real Redis semantics.** The harness uses a fake-Redis stub;
  production runs real Redis (DEPLOY.md's post-deploy checks exercise
  it, but no suite does).
- **Settlement via magic-link / repo-claim link paths.** Accrual
  settlement triggers inside the shared `addLinkedWallet` funnel and is
  proven end-to-end for the *signature* (Flow A) path; the magic-link
  and repo-claim paths use the same funnel but were not separately
  driven.
- **Partial-failure settlement.** If the reward pool empties mid-backlog,
  the remainder stays pending and retries on the next link — implemented
  and logged, never exercised in a test.
- **The Claude Code hook in a live Claude Code install.** The hook
  script was verified against stubbed `curl` (including exit-0 on every
  input), not inside a real Claude Code session.
- **Cooldown / daily-cap rejection paths** were not re-exercised in the
  newest drivers (covered by the verifier's design + earlier suites).

Fixed since the last tester pass:

- **Ship reports filed AFTER their push never reconcile — FIXED
  2026-11-24.** Found live 2026-11-24: `resolveShipReport` ran only
  at webhook time, so a report filed for an already-processed push
  sat in `reported` until expiry even though the outcome was already
  recorded. Report creation now reconciles against the verifier's
  recorded push log: rejected pushes resolve to `rejected` with the
  recorded reason, counted pushes on grant-backed repos resolve to
  `confirmed` with the derived verified push count. (The log records
  no per-push tx hashes, so a late report is never reconstructed to
  `paid`; counted pushes on grant-less repos stay `reported` — they
  never take `confirmed`, and a pending-accrued reward still flips
  the report to `paid` with the real tx when it settles on wallet
  link.) Covered by run-attestation.sh case (f).
- **Recent-pushes feed showed grant-backed pushes only — FIXED
  2026-11-24.** Grant-less counted pushes were processed into the
  same push log but no grant existed for the feed to enumerate.
  `processPushGrantless` now indexes grant-less-active repos and
  `GET /api/vesting/recent-pushes` merges both sources (response
  shape unchanged). Covered by run-rewards.sh case (a).

## 5. Reporting a bug

Capture, at minimum:

- **Repo** (`owner/repo`) and the **commit SHA** (merge SHA if a PR).
- **What you did** — lock / grant-less, PR number, who authored, whether
  a wallet was linked (and which link flow).
- **Timestamps** (with timezone) of the push/merge and of your checks.
- **Ship-report state** if you filed one (`reported` / `confirmed` /
  `paid` / `rejected` / `expired`) plus any tx hashes on the record.
- **What you expected vs what happened** — counter moved or not, reward
  paid / pending / missing, balances before/after.
- Chain + token addresses if a lock is involved.

A report with repo + SHA + timestamps is debuggable from the webhook
log and the on-chain record alone; without the SHA it usually isn't.
