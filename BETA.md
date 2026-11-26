# Proof of Dev — Beta Tester Guide

> **Status: NOT LIVE YET.** This guide describes the beta flow as built and tested locally. The beta opens only after (1) the independent source review clears, (2) GitEscrowV2 + FeeStreamEscrow are deployed, and (3) the backend is redeployed with the launch gate configured. Nothing in this guide is a promise that a surface is reachable today. When the beta opens, this header will be replaced with the live URLs.

## What Proof of Dev is

You launch a token through the platform (Bankr launch SDK under the hood). As part of the launch, you lock part of your supply in an escrow that **cannot be cancelled** — by you, by us, by anyone. It unlocks only as verified pushes land on your GitHub repo. Your **trading fees** also lock: they collect in a per-project vault and unlock on the same counted pushes. Waiting earns nothing. Shipping earns everything.

There are two ways to participate: **launch** (your token, your repo, your unlocks) and **review** (your agent verifies other people's pushes and earns platform rewards).

## Prerequisites

- A GitHub account and a repo you own or admin (public or private; the App needs installation on it).
- An EVM wallet on Base (chainId 8453). This is your **claim wallet** — rewards and releases pay it. You will prove you own it by signing a message; never share a private key or seed phrase with anyone, including any agent acting for the platform.
- A small amount of ETH on Base for the launchpad bond and launch costs (exact figures shown in the launch flow before you sign anything).
- Optional: an AI agent (Claude or compatible) if you want the agent flow (MCP tools + skill) instead of the web flow. The steps are identical; the agent just drives them.

## Step 1 — Install the GitHub App

Install the platform's GitHub App (`bankr-vesting`) on the repo you will ship from. The platform checks, server-side: the App is installed on that repo, your GitHub login owns or admins it, and the wallet you present is linked to that login. No verification, no launch — this is enforced by the launch endpoints, not by policy.

## Step 2 — Link your wallet

Sign the link challenge with your claim wallet. The link binds **GitHub login ↔ wallet**. Rewards, enrolment, and reviewer payouts all resolve through this link. One login can re-link; the latest proven link wins.

## Step 3 — Verify for a launch

Request a launch verification for the exact repo + wallet + chain. You receive a short-lived (15-minute) verification token bound to all three. The same token is reused across the prepare → lock → register steps of one launch (that reuse is intentional); it cannot be used for a different repo, wallet, or chain, and it expires.

## Step 4 — Prepare the launch

Call prepare-launch (web or the MCP `prepare_launch` tool) with your verification token and your launch parameters. The onboarding order is fixed, and every step before yours is the platform's job — and it is now an endpoint, not a manual operator errand: **`POST /api/launch/onboard`**, called with the same verification token (the web wizard calls it automatically at the Prepare step when your project has no vault yet; agents call it directly). Onboarding derives everything from your verification and the platform's own configuration — you supply no vault, escrow, token, or ledger addresses — and it is idempotent and resumable: calling it again returns the vault you already have, and if its grant registration ever fails after your vault deployed, a retry registers the grant against that same vault instead of deploying a second one.

1. **The platform deploys your fee-lock vault** from the platform's one approved vault implementation, bound to your repo, your claim wallet, the platform's fee escrow, the chain's WETH, and the Bankr claim ledger. You never deploy the vault yourself.
2. **The platform registrar registers your fee grant** on the fee escrow (recipient, vault, fee token, pushes-per-tranche). You never register the grant yourself.
3. **Prepare-launch verifies, then answers.** Before it returns anything signable, prepare-launch re-reads the vault on-chain and checks **every binding** (repo, launcher, escrow, WETH fee token, Bankr claim ledger) plus the approved-implementation codehash, and confirms the **matching fee grant is registered** with the same recipient, vault, token, and schedule. Any mismatch refuses with a specific code (`LAUNCH_VAULT_REPO_MISMATCH`, `LAUNCH_VAULT_LAUNCHER_MISMATCH`, `LAUNCH_VAULT_ESCROW_MISMATCH`, `LAUNCH_VAULT_TOKEN_MISMATCH`, `LAUNCH_VAULT_LEDGER_MISMATCH`, `LAUNCH_FEE_GRANT_NOT_REGISTERED`, `LAUNCH_FEE_GRANT_MISMATCH`) — no input is returned for a wrongly-bound vault or a missing grant, so a bad configuration is caught **before** you launch, not after.
4. **You get back the exact launch input the platform approves:**
   - **Fee split (of the creator fee slice):** 25% to the platform reward treasury, 75% to your project's fee-lock vault. Never to your raw wallet — that is what makes your fees lock instead of arriving liquid.
   - **Bankr time-vesting: explicitly zero.** Your unlock schedule is the push schedule, not a calendar.
   - Your token name, ticker, and supply terms are yours.

If the reward treasury is not configured on the platform or any check above fails, prepare-launch refuses — closed doors are deliberate; nothing half-launches. One more thing to expect later, when your fees vest: a fee release settles in capped batches, so vested fees may show as **still settling** until the platform's sweep finishes the batch — that is the release working as designed, not a stuck payment, and it completes even if you stop pushing.

**If your verification token expires mid-flow:** the 15-minute token covers the interactive steps, and a launch can outlast it. If it expires between launch and registration, re-run Step 3 to get a fresh token and register with the fresh token — do NOT re-prepare. Registration binds to your ORIGINAL prepared record: the fresh token must chain to the same GitHub login, repo, wallet, and chain, issued at or after the original verification, and the lock's ordering is judged against the ORIGINAL verification time, so a lock you made in good order is never failed for predating the fresh token. If your registration already landed, repeating it changes nothing — the platform refuses a duplicate active grant and the original stands.

## Step 5 — Launch, then lock supply as part of launch

The lock does not happen by itself — you sign it as part of the launch sequence. These are the transactions you sign, in order, all from your own wallet:

1. **Launch transaction** (you sign): the SDK launch, executed with the exact prepared input from Step 4 — your token is created with the 25/75 fee recipients (treasury / your fee-lock vault) and Bankr time-vesting explicitly zero.
2. **Approve transaction** (you sign, only if the flow asks for it): lets **GitEscrowV2** pull the supply amount you are locking. Check the spender is the platform's configured v2 escrow and the amount matches your lock size before signing.
3. **Lock transaction** (you sign): moves the agreed supply into **GitEscrowV2** for your repo. Total pushes and pushes-per-milestone are set here, at lock time, and cannot be changed afterwards.
4. **Registration** (no funds move): you submit the registration (web, API, or MCP) presenting the lock transaction. The platform verifies the whole chain of evidence — the prepared-launch record made under your verification, verification ordering, that the lock transaction's own event names your repo, your wallet, and your token, the vault's approved implementation and bindings, the launch's actual fee recipients, and that the lock sits in the configured v2 escrow — and stamps your grant as a **verified launch**. Only verified launches are listed, enrolled, and counted as platform projects. (You can also make an *ordinary lock* without any of this; it works, it just carries no launch recognition.)

### If the launch succeeds but the lock or registration is interrupted

This is recoverable, and the safe move is patience, not a redo:

- **Your token exists and is safe.** A completed launch with no lock yet means the supply is simply still in your wallet, trading live with the prepared fee recipients. Nothing is locked, nothing is lost, and no deadline runs against you.
- **Do NOT relaunch.** A second launch creates a second token; it does not fix the first one, and only the original prepared record can earn the verified stamp.
- **Re-run just the interrupted step** with the same prepared record: if the lock never landed, sign the approve (if asked) and lock transactions from Step 5; if the lock landed but registration did not, submit the registration again. A landed step never needs repeating — the platform refuses a duplicate active grant and the original stands.
- **Token expired in between?** Same rule as Step 4: re-verify for a fresh token and continue with it. The verified stamp is judged against your ORIGINAL verification and prepared record, so an interruption never costs you the ordering you earned.
- **Still stuck?** Use the Support path below, with your repo, the launch transaction hash, and (if it exists) the lock transaction hash. Every check the platform runs reports a specific refusal code, and that code says exactly which step to redo.

Read this part twice: **the v2 lock has no cancel.** Not for recipients, not for the platform, not on request, not by an agent you instruct. If your GitHub repo or the App becomes unavailable, recovery is by verifier redundancy — the escrow owner rotates the oracle and a backup verifier recounts your pushes from the recorded log — never by unlocking early.

## Step 6 — Ship

Push real code to your production branch (`main`, `master`, `production`, `prod`). A push counts when:

- it changes real code files (docs/lockfile/policy-only diffs do not count; on the raw-push path each code file is estimated at ~5 lines against a 3-line minimum; merged PRs use real diff stats),
- it is not from a bot/App account and not a force-push,
- it is not a duplicate of an already-counted push,
- at most **3 counted pushes per day** per repo, with a **30-minute cooldown** between counted pushes (a substantial change, ~50+ estimated lines, bypasses the cooldown),
- and it clears the mandatory swarm review window (below): every push that passes the verifier rules opens a **6-hour review window**; it counts early with 2 independent reviewer passes, is vetoed by any fail inside the window, and otherwise counts on the verifier's result alone when the window expires.

Each counted push advances your supply milestones **and** your fee tranches. Fee tranches lock continuously as trading fees accrue to your vault (a permissionless keeper claims and locks them); each tranche vests over the counted pushes that come after it locked.

## Reviewing (the second way to earn)

Any linked wallet can enrol as a reviewer (`enrol_reviewer` via MCP, or the agent endpoints). You receive a queue of pushes you are independent of — you cannot review your own pushes, your own repo, or pushes whose author shares your wallet. For each, you check the diff: is the code genuinely new (the platform fingerprints every counted diff; exact duplicates are auto-flagged and can never count), meaningful, and passing? Attest pass or fail. Swarm review is **mandatory on every grant** (adopted 2026-11-26 — there is no launcher opt-in or opt-out): a push that passes the verifier rules opens a **6-hour review window**. Inside the window, **2 independent passes** count the push immediately; **any fail vetoes it** and it never counts. If the window expires with no fail and fewer than 2 passes, the push counts on the verifier's result alone. Every counted push records which path counted it — **swarm** (quorum) or **verifier-fallback** (window expired) — and the marker is shown wherever push status is surfaced. A release already settled is never reversed by a late attestation. Reviewer rewards are paid only on pushes that count via the swarm path (fallback pushes have no quorum to pay). Reviews are a gate, never a payout trigger by themselves: money moves only on the webhook → verifier → oracle path.

## What you earn, in one place

- **Launcher:** your locked supply, released at milestones; your trading fees, released as fee tranches vest. Both stop the moment you stop shipping.
- **Author of a counted merge:** the per-merge platform reward (paid to the merge author, who may differ from the launcher).
- **Reviewer:** the reviewer reward on each counted merge you passed in quorum.

## Known limits (beta honesty)

- The platform reward token and production reward amounts are set at beta launch; test deployments used mock amounts.
- Fee denomination is **WETH** for the first launch (denominated in WETH, so its fiat value still moves with ETH). A swap-to-your-token option is planned, not built.
- The push log used for recovery recounts is retained per repo (checkpointed); a recount certifies only history it can cover and refuses rather than estimates when it cannot.
- Contracts are locally tested and independently agent-reviewed; treat beta amounts as dust until a full audit is published.
- A launch made entirely outside the platform (the Bankr SDK is permissionless) cannot be stopped — it simply receives no verified-launch recognition. Ordinary locks and grant-less authors still count and earn through their own paths; what an outside launch never gets is the verified-launch stamp, the listing, and launcher enrolment.

## Support

During the beta, issues go through the platform operator (Gregory) directly — there is no support desk. The trust model, stated exactly: **no one can cancel your lock or pull your tokens out early — there is no cancel function and no recipient exit, for anyone.** What the platform operator CAN do is rotate the oracle, and the oracle is the component that supplies the counted-push totals that authorize releases. A compromised or malicious oracle is therefore a trust assumption of this design, named as such: it could report counts that did not happen. It cannot redirect tokens to itself (releases pay only the grant's recipient, on the schedule fixed at lock time), and every count it reports is checked against the platform's recorded push log in recovery recounts. If something looks wrong, include your repo, your grant's chain + contract address, and the push SHA in question; every decision the system made about a push is in its log with the reason attached.
