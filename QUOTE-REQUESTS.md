# Proof of Dev — Audit Quote Requests

**DRAFTS — NOT SENT — awaiting Gregory's go-ahead.** Prepared 2026-11-26. No firm has been contacted. These drafts exist so that, once Gregory approves the shortlist and budget ceiling (AUDIT-SCOPE.md §6), quote discovery can start immediately for lead-time purposes. The audit itself binds to a frozen commit after the internal Codex review round 5 completes; no engagement starts on unfrozen code.

Both drafts request the **identical structure** (AUDIT-SCOPE.md §5) so the two prices are comparable: one fixed fee covering named reviewers, the written report, and one fix-verification (remediation) pass against a pinned commit; the legacy v1→v2 cutover review included in both base quotes; a standalone fresh audit of v1 `GitEscrow.sol` priced as a separate add-on line; the broader GitHub/swarm review as an optional separate line item only.

Both quotes are for the **upcoming beta**: the existing-token lock flow is live today; the new launch flow is pending review and deployment.

---

## Draft A — Boutique / managed review (Pashov-class firm or Cantina managed review)

*Address to the chosen boutique firm or Cantina's managed-review team, unchanged in substance.*

**Subject:** Fixed-fee audit quote request — Proof of Dev (escrow + fee-lock contracts, preliminary Solidity estimate ~666 nSLOC + TypeScript enforcement layer, Base)

Hello [name / team],

We are preparing the beta launch of **Proof of Dev**, a platform that turns verified GitHub work into token unlocks: a builder verifies their repo through our GitHub App, launches a token through the Bankr launch SDK with a platform fee template, locks supply into a no-cancel escrow, and from then on both the locked supply and the launcher's own trading fees unlock only as verified, counted pushes land. The contracts will custody other people's locked tokens and fee streams, and the product's core claim is the integrity of that lock — which is why we are auditing before any production deployment. Both quotes are for the upcoming beta: our existing-token lock flow is live today; the new launch flow described here is pending review and deployment.

**Scope — smart contracts (preliminary Solidity estimate ~666 nSLOC, Solidity ^0.8.24, Base; the TypeScript enforcement layer is scoped in below):**

- `GitEscrowV2.sol` — supply lock; oracle-only milestone releases; no cancel, no recipient exit.
- `FeeStreamEscrow.sol` — fee-stream lock; per-tranche baselines set from oracle-signed EIP-712 count attestations verified on-chain; capped, cursor-based fee releases.
- `FeeLockVault.sol` — per-project claim front end; exactly two state-changing functions, all bindings immutable, no admin.
- `ShipRewards.sol` — pre-funded reward pool; oracle-only payment, one payment per merge enforced on-chain.

**Scope — off-chain enforcement layer (in scope, inside the fixed fee):** the contracts trust values produced off-chain, and we want the code that produces them reviewed with the same rigour: the count-attestation signer (`src/lib/countAttestation.ts` and its issuance endpoint), the prepare-launch vault/grant binding checks (`src/api/launchVerify.ts`, `src/lib/launchRecognition.ts`), the deployment configuration surface (`src/lib/env.ts`, `src/lib/chains.ts`, including oracle key handling), and the release worker that drains queued payouts until the escrow reports zero due (`src/oracle/feeLock.ts`, `scripts/fee-release-sweep.ts`, `scripts/fee-lock-keeper.ts`). A contract-only pass could verify a signature is valid while leaving open whether the signer attested to the right count; we are asking you to close that gap.

**Legacy cutover, included in the fixed fee:** Review the deployment and backend routing changes that preserve servicing for existing v1 grants while directing new beta grants to v2. Verify that existing grants retain their escrow address through release, retry, and oracle recovery, and that new verified launches resolve to v2. Price a standalone audit of the v1 contract separately.

**Optional, priced separately if you offer it:** a review of the broader GitHub webhook/push-verifier pipeline and the agent reviewer-swarm system. Not part of the fixed fee.

**Quote structure requested — one fixed fee covering:**

1. The review itself, by **named reviewers** (please name the reviewers or senior researchers who would do the work).
2. The **written report**.
3. **One fix-verification (remediation) pass**: we remediate findings on a pinned commit; the same reviewers verify the fixes. Included in the fixed fee, not quoted afterwards.

**Separate add-on line:** a standalone fresh audit of `GitEscrow.sol` (v1, ~229 nSLOC), already deployed on Base and Robinhood Chain, holding live grants our production backend still services — please price that standalone audit as a separate add-on we can accept or decline independently. (The cutover review above is in the fixed fee; this add-on is the v1 contract's own audit.)

**Timeline ask:** please state your current lead time to kickoff and the expected engagement duration. Note on our side: the audit binds to a **frozen commit** that is currently completing an internal review round; we are requesting quotes now for lead-time and budgeting purposes, and the frozen commit, source manifest, and full packet will be delivered at engagement start. No work is expected before that freeze. Rollout, for context: the launch flow goes live only after the v2 and fee contracts deploy, the backend redeploys with legacy routing intact, and a controlled live proof passes — three separate steps after this audit, not one redeploy.

**What we hand over:** the frozen commit with a sha256 source manifest; `AUDIT-SCOPE.md` (scope, trust assumptions, exclusions); `CODEX-REVIEW.md` (architecture and the full internal review history — four prior review rounds with findings and fix evidence, so your reviewers can attack the fixes rather than rediscover the seams); the complete test suites (E2E and unit, with pass counts); `BETA.md` and `LAUNCH-GATE.md` (what users are told — doc-vs-code drift is in scope to flag); and the deployment plan with production configuration.

Please reply with the fixed fee on the structure above, the v1 add-on price, named reviewers, lead time, and duration. If your model cannot price the off-chain modules, say so explicitly and quote the contracts alone — we would rather know than discover it at scoping.

Thank you,
[Gregory / fren, Proof of Dev]

---

## Draft B — Sherlock (comparison quote, private contest / Lead Senior Watson)

*Address to Sherlock's scoping contact. Same scope and structure as Draft A, framed for Sherlock's model.*

**Subject:** Quote request — private review, Proof of Dev (escrow + fee-lock, preliminary Solidity estimate ~666 nSLOC + TypeScript off-chain enforcement layer)

Hello Sherlock team,

We are preparing the beta launch of **Proof of Dev**, a platform that turns verified GitHub work into token unlocks: builders verify a repo through our GitHub App, launch a token through the Bankr launch SDK with a platform fee template, lock supply into a no-cancel escrow, and both the locked supply and the launcher's trading fees then unlock only as verified, counted pushes land. The contracts will custody other people's locked tokens and fee streams pre-launch, and we are auditing before any production deployment. Both quotes are for the upcoming beta: our existing-token lock flow is live today; the new launch flow described here is pending review and deployment.

We are requesting a **comparison quote** against a boutique/managed quote we are obtaining in parallel, on an identical scope and structure, and we are asking you to price the model that fits it best — a private contest with a Lead Senior Watson, or your closest equivalent.

**Scope — smart contracts (preliminary Solidity estimate ~666 nSLOC, Solidity ^0.8.24, Base; the TypeScript enforcement layer is scoped in below):** `GitEscrowV2.sol` (supply lock, oracle-only releases, no cancel), `FeeStreamEscrow.sol` (fee tranches with oracle-signed EIP-712 count-attestation baselines, capped cursor-based releases), `FeeLockVault.sol` (two-function claim front end, immutable bindings, no admin), `ShipRewards.sol` (oracle-only reward pool, one payment per merge).

**Scope — off-chain enforcement layer (in scope):** the count-attestation signer (`src/lib/countAttestation.ts` + issuance endpoint), prepare-launch vault/grant binding checks (`src/api/launchVerify.ts`, `src/lib/launchRecognition.ts`), deployment configuration (`src/lib/env.ts`, `src/lib/chains.ts`, oracle key handling), and the payout-drain release worker (`src/oracle/feeLock.ts`, `scripts/fee-release-sweep.ts`, `scripts/fee-lock-keeper.ts`). The contracts verify these modules' outputs on-chain; whether the modules produce the *right* outputs is the other half of the guarantee, and we want it reviewed. If the contest format cannot cover off-chain TypeScript, tell us how you would handle that portion (e.g. Lead Watson scope) rather than dropping it silently.

**Legacy cutover, included in the fixed fee:** Review the deployment and backend routing changes that preserve servicing for existing v1 grants while directing new beta grants to v2. Verify that existing grants retain their escrow address through release, retry, and oracle recovery, and that new verified launches resolve to v2. Price a standalone audit of the v1 contract separately.

**Quote structure requested — one fixed fee / pool covering:**

1. The review, with the **Lead Senior Watson and judging researchers named**.
2. The **written report** (contest findings report in your standard form).
3. **One fix-verification (remediation) pass** against a pinned remediation commit, included in the quoted figure.

Please give the **all-in engagement price**, with the prize pool, judging, off-chain review, and fix verification **itemized** within it, so we can compare line for line against the boutique quote.

**Separate add-on line:** a standalone fresh audit of v1 `GitEscrow.sol` (~229 nSLOC), deployed on Base and Robinhood Chain with live grants that our backend still services — priced separately, accept/decline independently. (The cutover review above is in the fixed fee; this add-on is the v1 contract's own audit.) **Optional separate line:** review of the broader GitHub webhook/verifier and reviewer-swarm systems.

**Timeline ask:** lead time to contest start, contest window for the ~666 nSLOC preliminary estimate, and judging + fix-review duration. On our side: the audit binds to a **frozen commit** now completing an internal review round; quote discovery is happening now for lead-time purposes, and the frozen commit with sha256 source manifest and the full packet (scoping document, architecture + four rounds of prior review history, full test suites, deployment plan) is delivered at engagement start. Rollout, for context: the launch flow goes live only after the v2 and fee contracts deploy, the backend redeploys with legacy routing intact, and a controlled live proof passes — three separate steps after this audit, not one redeploy.

**One additional question:** post-audit coverage — please state your current coverage terms and any conditions attached, so we can budget the post-launch layer alongside the audit decision.

Thank you,
[Gregory / fren, Proof of Dev]
