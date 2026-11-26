# Proof of Dev — Codex Review Document

**For:** an independent reviewing agent (Codex). **Date:** 2026-11-25.
**Repo:** `anondevv69/github-vesting`, branch **`codex-review-round2`** — this snapshot is the **round-3 fix commit** on top of the round-2 content commit `b409ab386d7c83aac99d8ac38ebe2e99afbd7c2e` (the tree the round-3 review read). The round-3 commit's own SHA is reported with the branch link at delivery (a document cannot contain the SHA of the commit that contains it); the tree was secret-scanned before commit, same method as round 2 (all keys in the tree are public Hardhat test keys). The source manifest below lets you verify any file independently.
**This is the single review document.** It supersedes `REVIEW-PACKET.md`. Every claim below names its code path or test; the tx-level record of the mainnet test legs is `TEST-SDK-ECOSYSTEM-REPORT.md` (§§1–15).

## What Proof of Dev is, and where it actually stands

Proof of Dev turns verified GitHub work into token unlocks. A builder verifies their GitHub repo through the platform's GitHub App, launches a token through the Bankr launch SDK with the platform fee template, locks supply into a no-cancel escrow, and from then on the tokens — the locked supply **and** the launcher's own trading fees — unlock only as verified, counted pushes land. Other people's agents can act as independent reviewers whose quorum gates whether a push counts, and every counted merge pays its **author** a platform reward token.

**Honest status, one paragraph:** everything described here is **local code plus local tests — nothing from the 2026-11-25 work is deployed to PRODUCTION, and no production token launch has occurred.** The only mainnet artifacts are Base-mainnet DUST deployments from the round-2 live claim proof (test wallets, dust amounts): FeeStreamEscrow `0x49fb1c1583c2269fef3da69aaa4c1d3ee33cbe9f`, FeeLockVault `0xe25f58d5c4343bdc00756e3a71676bd64f65d744`, and the dust token `0xfaB653e1b6898f997838E08070825Cb97877cf39` (full tx hashes in the R2-1 section). Those contracts predate the round-3 changes in this snapshot (registrar-only grant registration, `backendCountAtLock`, the release cursor) — nothing new was deployed this pass. The components are proven as separate legs (a Base-mainnet dust launch at test parameters, local Hardhat contract lifecycles, and fixture-driven E2E suites running the real backend, verifier, oracle, and contracts against a local chain). The one leg that has never run is the single end-to-end flow — GitHub verification → production-split launch → v2 lock → live counted push → live payout — because its final step needs the GitHub App installed on a real repo and a push from the owner's account. That step is listed among the owner-only steps at the end, and no sentence in this document should be read as claiming it has happened.

Three definitions, kept distinct throughout (conflating them was a previous review finding):

- **Ordinary vesting lock** — the web-wizard flow: a user locks their own ERC-20 for a repo and registers with **no** verification token. Works today; not a launch; carries no launch recognition.
- **Platform launch** — a Bankr SDK launch prepared through Proof of Dev surfaces (`POST /api/launch/prepare-launch`), gate-enforced, using the platform fee template.
- **Verified-launch recognition** — a grant stamped `launchVerified` at registration (valid gate token + a prepared-launch record the token binds to + proven ordering + the lock event matching the registration), which is what puts a project on the verified-launch listing and enrols its launcher.

## Response to the previous Codex review — findings 1–5

### Finding 1 — Separate legs presented as one flow; the gate covered lock prep and recognition, but no launch surface existed to gate

**What was wrong.** The packet blurred separately-proven legs into an implied end-to-end flow, and "verification is mandatory before a launch" was unenforceable on any launch because no surface built SDK launch inputs; ordinary no-token vesting registration also existed without the docs distinguishing it from a verified launch.

**What changed.**
- Docs (§13 of the report; the readiness statement above) now present the legs separately with their actual parameters: the mainnet dust launch used a **70/30 test split** and **inherited the SDK default 15% time-vest** (because `vesting` was omitted); approve and lock were **separate transactions**; the lock went into **v1** (which has recipient cancel) and covered **20% of the dev-buy position**. "No production token launch" replaces "no real token launch" (PODX did launch on Base mainnet, dust).
- An unstamped grant's exclusion from recognition is now **proven, not just documented**: `tests/e2e/run-launch-exclusions.sh` (**13/13**) — absent from the verified-launch listing (`GET /api/launch/projects`, built for this), flagged `launchVerified:false` on explore, no launcher enrolment, before and after a counted push (its pushes still count toward its own ordinary schedule, by design).
- **The launch-prep surface now exists** (this pass): `POST /api/launch/prepare-launch` (`src/api/launchVerify.ts`) + MCP `prepare_launch` (13 tools, parity-tested). It requires a valid gate token for the exact repo+wallet+chain, requires a fee-lock vault address, and returns `buildPlatformLaunchInput()` output — production 25/75 split, vesting explicitly `{bps: 0}`. Fail-closed (503) while the treasury wallet is undesignated. Verification is now mandatory before a platform launch **at the one launch surface that exists** — stated in exactly those terms in `LAUNCH-GATE.md`.

**What is now true.** The gate enforces lock preparation, launch preparation, and recognition. A launch executed entirely outside the platform still cannot be stopped (the SDK is permissionless) and receives no recognition.

### Finding 2 — Enrolment and payout were conflated; the payout path pays the PR author, not the launcher; the fee loop was described as operating

**What was wrong.** Docs promised the **launcher** payment on every counted merge; the committed path pays the **PR author** (one payment per merge hash, `ShipRewards.paid[]`), including on grant-less repos. The fee-recycling loop was described as operating while the treasury wallet and production reward token were still pending.

**What changed.**
- Docs everywhere now state: enrolment is an **eligibility record**; the per-merge reward pays the **author**; the two are separate. No payout code changed for this (§13).
- The launcher's own benefit is now defined by Gregory's rule and **built** (this pass): the launcher's trading-fee share is paid to a per-project **FeeLockVault** and auto-locks into a fee-stream grant unlocking by counted pushes — see "The fee-lock system" below. The author reward is untouched by it (proven in the same E2E: PR #42's push pays the author +10 RWD while fee tranches release to the launcher/recipient).
- The fee-recycle loop (treasury claims → buys reward token → tops up ShipRewards) is described as **designed, not operating** everywhere it appears: the treasury wallet is undesignated and the production reward token does not exist.

### Finding 3 — Verifier counting weaknesses: the 5-line estimate overclaim, and the duplicate-check race

**What was wrong.** On the raw-push path any non-ignored file is estimated at 5 lines against a 3-line minimum, so the filter does less than "real code" wording implied. Separately, duplicate detection (SISMEMBER) and counter updates were separate Redis operations — concurrent deliveries could both pass and double-count vesting progress.

**What changed.**
- Docs state the estimate plainly (packet, `LAUNCH-GATE.md`, report): the raw-push path **estimates 5 lines per non-ignored file vs a 3-line minimum**; the PR-credit path uses real diff stats; the cooldown exception for substantial changes (~50+ estimated lines bypasses the 30-minute cooldown) is documented.
- The race is **fixed in code**: `recordVerifiedPush` (`src/github/pushVerifier.ts`) performs claim-and-record as a single Lua script (SHA claim + daily counter + push log + push counter, atomically; returns null when already claimed, treated as a duplicate rejection by `processPush.ts`). New suite `tests/e2e/run-concurrency.sh` — **6/6**: the same webhook fired twice in parallel counts exactly once (+1 push, one 500 PTK release, one 10 RWD author reward).

### Finding 4 — The recovery test proved oracle rotation and release, not an equivalent recount

**What was wrong.** The GitHub-death test recounted from `git log` (84 commits capped at the grant's 10), which does not reproduce webhook acceptance, author attribution, the daily cap, or the cooldown; "nothing is trapped and nothing leaks" overclaimed it.

**What changed.**
- The overclaim was deleted (§13); §7 now states only what that test proved and its dependencies.
- **The equivalent recount is built** (this pass): `src/lib/recount.ts` replays the backend's **recorded push log** (accepted and rejected entries) through the verifier's actual rules — production branch, bot sender, meaningful-change minimum from the recorded line estimate, duplicate SHA, daily cap by recorded timestamp, cooldown with the substantial-change exception — **recomputing** acceptance from recorded fields rather than trusting the recorded `accepted` flag. `scripts/recount-and-release.ts` is the backup-verifier tool: recount, compare against the live counter, then release against the recount with the rotated (backup) oracle key.
- New suite `tests/e2e/run-recount.sh` — **11/11**: an 8-delivery mixed history (counted, cooldown-rejected, bot, duplicate, docs-only, daily-cap-rejected) recounted from the log equals the webhook-counted total (**3 = 3**); after owner rotation, the backup release pays **exactly** the one milestone the dead oracle missed (recipient 600 → 900 PTK; escrow drained per schedule; milestones 1–2 not double-paid). The git-log test is superseded as the recovery evidence.
- **Dependency, stated plainly:** the recount is only as complete as the recorded push log — trimmed to the last 200 entries per repo, and undelivered webhooks leave no entry. Recovery requires (1) the escrow owner rotating the oracle and (2) this log being retained.

### Finding 5 — Test parameters mixed with production settings

**What was wrong.** The user-facing diagram showed 70/30 while the intended split is 25/75 of the creator slice; the mainnet dust launch used 70/30 and inherited the 15% time-vest; approve and lock were separate transactions; the lock covered 20% of the dev-buy.

**What changed.** Every diagram and doc now labels 70/30 as the **test-launch parameter** and 25/75 as **production, of the creator slice** (after the Bankr v4 pad's built-in routing — Bankr cut, auto-LP, holder share, ~47.5% on tested pad defaults — comes off the total fee first; 25/75 is never presented as a split of the whole trading fee). The legs table (report readiness statement; §13) states the dust launch's parameters together: 70/30, inherited 15% vest, separate approve/lock transactions, v1 lock, 20% of the dev-buy. The production template sets `vesting: {bps: 0}` explicitly (fee-config test, now 9/9).

### Additional gaps from the review's open list — disposition

- **Wrong-chain / missing-issuance-record gate cases:** added as named tests (§13) — `LAUNCH_TOKEN_CHAIN_MISMATCH`, `LAUNCH_TOKEN_UNKNOWN_NONCE`; both refuse.
- **Token reuse within the TTL:** defined as **intentional** for the same repo+wallet+chain across prepare → confirm → register (multi-step flow), and test-asserted; cross-binding and post-expiry reuse refuse.
- **Registration must prove the launch/lock happened after verification:** implemented (§13) for lock txs carrying a `Locked` event (block timestamp vs token `iat`; predating → unstamped), and **made fail-closed in this pass**: a registration tx with no provable lock timestamp now also withholds the stamp (`LAUNCH_ORDERING_UNPROVABLE`). Gate suite step 24 proves it; current counts are in the test inventory below.

## The fee-lock system

Gregory's rule: **a launcher's trading fees must not arrive liquid.** Built locally in this pass; not deployed.

**Design.**
- On a platform launch, the launcher share (7500 bps of the creator slice) names the project's **FeeLockVault** (`contracts/FeeLockVault.sol`) as fee recipient — never the launcher's raw wallet. The platform's own launch is the exception that proves the template's shape: there the launcher is Gregory and the share goes to his wallet.
- The vault is a claim-capable contract (claims are beneficiary-signed; the escrow contract itself could never claim). It has exactly **two** state-changing functions: `claimFees(source)` — pulls the vault's accrued fees in from a claim source (the source pays the vault as beneficiary, never the caller) — and `lockAccrued(expectedBaseline, backendCountAtLock)` — pushes the vault's **whole** fee-token balance into its escrow grant, stamped with the max of the two counted totals (round-3; see R3-3). There is no withdraw, sweep, rescue, or arbitrary-transfer function, and no path that can pay the launcher or any other address; the escrow address is immutable at construction.
- `contracts/FeeStreamEscrow.sol` holds fee-stream grants (a companion contract rather than an extension of GitEscrowV2, because each fee tranche carries its own baseline — the counted-push total when it locked — which supply grants do not have; v2 is untouched). Since round 3, a grant is registered **only by the escrow's owner (the platform registrar)**, naming recipient + token + vault + `pushesPerTranche` explicitly, and the contract validates the vault's immutable bindings on-chain before accepting (see R3-2). Only the registered vault can add tranches; only the oracle can release.
- A permissionless **keeper** (`scripts/fee-lock-keeper.ts`) runs claim → lock for due vaults. It needs no trust: it cannot receive or redirect fees. Since round 3 it also enforces the pending-report gate: while a fee report for a grant is pending retry, it defers before moving any funds (see R3-3).
- **Releases** run through the same oracle path as supply: on every counted push, the backend (`src/oracle/feeLock.ts`, hooked into `src/github/processPush.ts` after the supply release) calls `releaseFee(repoId, totalVerifiedPushes)` with the same oracle signer. Each tranche vests pro-rata over the next `pushesPerTranche` counted pushes after its baseline; the contract pays the vested delta to the launcher's claim wallet. Fee vesting is independent of supply milestones (different schedule), and delta-based on-chain accounting plus the verifier's atomic claim make webhook replays non-double-paying. A launcher who stops shipping keeps neither stream: no new counted pushes, no new vesting, no time-based release, no cancel.

**Denomination — DECIDED (Gregory, 2026-11-25): WETH for the first launch.** The vault locks the asset it holds; the built, tested, and now mainnet-proven path is **lock-as-claimed (WETH)**. The alternative — swapping claimed WETH into the project token via PodSettler before locking — is documented as a config-gated option, **not built**, and deferred until it is built and tested.
- *Lock as WETH:* unlocks pay out the claimed asset — denominated in WETH, so its fiat value still moves with ETH; simple, and holders get no buy pressure from fees.
- *Swap to the project token first:* unlocks pay the launcher in their own token and every fee cycle is buy pressure on the chart — but the launcher's fee value rides their own token's price, and the swap needs a production `minOut` (the proven PodSettler is unaudited test code, WETH-only, tested with `minOut` 0).

**Test evidence** — `tests/e2e/run-fee-lock.sh` (local Hardhat chain, fixture GitHub API, mock claim source modelling the SDK's beneficiary-signed claim; current count in the test inventory below): prepare-launch refuses with no token, returns the production split with the vault at 7500 bps and `vesting.bps === 0`, refuses with no vault; the vault's state-changing ABI surface is exactly `claimFees, lockAccrued`, raw withdraw/transfer-selector calls revert, `lockAccrued` with nothing accrued reverts, non-vault `addFeeTranche` reverts, non-oracle `releaseFee` reverts, non-owner `registerFeeGrant` reverts; keeper locks 40 WETH → escrow 40 / vault 0 / recipient 0 (zero pushes → zero released); push 1 → +20 WETH, no supply milestone; tranche 2 (30 WETH) locks at baseline 1; push 2 (PR #42) → tranche 1 completes, tranche 2 half-vests (55 WETH total), supply milestone pays 500 PTK, author reward +10 RWD; replay → all balances unchanged; push 3 → tranche 2 completes (70 WETH total), no supply milestone; plus the round-2 recognition + retry steps and the round-3 steps (R3-1/R3-3 above).

## Vesting vs locking

Both hold tokens back and release them in tranches; they differ in what turns the key.

- **Bankr time-vesting** (what the SDK does by default): the trigger is **time** — a cliff plus a calendar schedule, on a fixed preminted allocation set at launch. The **recipient pulls**: they sign a claim and take whatever time has unlocked, whether or not they did any work. Doing nothing still pays in full, eventually. (Omitting the SDK's `vesting` field silently defaults to a 15% time-vest — proven on-chain in the dust launch; the platform template therefore always sets `{bps: 0}` explicitly. Both systems running at once would say opposite things about the same supply.)
- **Proof of Dev locking**: the trigger is **work** — counted pushes, verified by the push verifier and, where enabled, gated by the reviewer swarm. The **oracle pushes**: releases are oracle calls against the counted-push total; the recipient cannot pull anything at any time. GitEscrowV2 has **no cancel** and no recipient exit of any kind (the v1 contract's recipient `cancel()` is deleted in v2 — ABI-verified, and raw + v1-ABI cancel attempts revert in `tests/v2-nocancel-test.ts`). The supply lock is a fixed amount on a fixed push schedule; the fee lock is a stream — new tranches keep arriving from trading and keep locking behind future work. Waiting earns nothing in either stream.

## Round-2 response — the four seams (2026-11-25, second fix pass)

The round-2 review accepted the round-1 fixes and found four gaps *between* the systems. All four are now closed with evidence; the claims below replace any weaker wording elsewhere in this document.

### R2-1 — The fee-lock test started at a mock claim source → REAL Bankr claim into the vault, proven on Base mainnet

The missing integration check has now run live, with test wallets only (compartment L5; total dust spend within the spike budget; no production wallet touched). Full driver + state: `~/workspace/agent-private-pay/hidden_files/sdk-spike/vault.ts` / `vault-state.json`.

- FeeStreamEscrow deployed on Base: `0x49fb1c1583c2269fef3da69aaa4c1d3ee33cbe9f` (deploy tx `0xd64484cb910ebefb1ea39dcf627f2f1a184c12996eacc5fbdb95a6a218f6f7a2`); FeeLockVault deployed: `0xe25f58d5c4343bdc00756e3a71676bd64f65d744` (deploy tx `0x72f99aa12923babf00c377c7bddc48ebe4a4809065eef054c31d7e03e7bc885d`); fee grant registered for repo `fren-test/pod-vault-claim` (tx `0xc58faa5d7a11a3405cfe392a69327610ae7598d93374f5d31909f23eec02a6b5`).
- NEW dust token launched through the SDK with the **vault as sole fee recipient** and vesting `{bps: 0}`: token `0xfaB653e1b6898f997838E08070825Cb97877cf39`, launch tx `0xe447af9fd25f65d3ca82b3fba708738d5fe389bb0861611d9dc53458600e95f0`. On-chain `launchInfo` confirms `feeRecipients = [{vault, 10000 bps}]`.
- Real fees generated via PodSettler buy + sell (txs `0x2cc314b32cb65b3c344aef0e4b65b47755f15ce72bf878f229b707e0c9126b21`, `0xcb64df6923157fd08d25838fdb29d25dc085bf47668db045d142de0d9c0324f1`).
- The SDK claim was built for beneficiary = the vault and executed **through `vault.claimFees`** (tx `0xc4e9771ac353460c91dfcdedfe5e88d441bf244852d7fea4041fe67ef80d46d5`): claimableQuote 3,568,251,387,035 wei → 0, and the vault's WETH balance went 0 → exactly 3,568,251,387,035 wei. **Bankr's actual claim mechanism accepts the contract vault as beneficiary and pays it.**
- Keeper `lockAccrued()` (tx `0x3bf0b0d03a23bace6403d3fddc2732aa3d43383019b9e9008c8253c7bd48b6de`): vault WETH → 0; the escrow now holds exactly 3,568,251,387,035 wei WETH as tranche 0 (baseline push count 0). Independently re-verified by RPC reads after the run (vault code 2,564 bytes; escrow balance exact; claimable still 0). Note: this live run used the round-2 one-argument `lockAccrued` and the round-2 first-caller `registerFeeGrant` — the round-3 snapshot changes both signatures (see the round-3 section); the dust contracts on mainnet are unchanged and nothing new was deployed this pass.
- Note: the Bankr fee ledger reports the vault as `claimRestricted` — the claim nonetheless succeeded through the vault as beneficiary-caller, which is exactly the path the design depends on.

### R2-2 — Prepared input vs the launch that actually happened → recognition binding

Registration now verifies the launch, not only the lock's timing (`src/lib/launchRecognition.ts`, wired into `src/api/register.ts`; prepare-launch records the prepared input + the vault's implementation hash at prepare time):

- **Vault identity (round-2 form; hardened in round 3 — see R3-2):** the recipient address must be a contract whose implementation hash equals the hash pinned at prepare time, and its immutable bindings (escrow destination, repoId, launcher) read on-chain must match the registration's repo + wallet. An impostor contract with the same interface but different code/bindings is refused (fixture `contracts/MockVaultImpostor.sol`).
- **Launch use:** the token's launch fee recipients, read from the launch record / fee ledger (`readLaunchFeeRecipients`, bucket-id derivation in the same module), must equal the prepared recipients (addresses + bps). A launch that used different recipients registers unstamped.
- **Lock destination:** the registered lock must sit in the chain's configured GitEscrowV2 / FeeStreamEscrow contract for the same repo + wallet — a lock in any other escrow does not stamp.
- **Gregory exception, scoped in code:** a raw wallet is permitted ONLY in the platform-recipient position (the 75% platform share — Gregory is the platform, not a launcher). The launcher position must be a vault: prepare-launch refuses a launcher-position EOA, and `launchFeeConfig` tests assert the treasury can never occupy the vault position either.
- Evidence: launch-gate suite steps for recognition, incl. correct vault → stamped; impostor → refused; recipients mismatch → unstamped; wrong escrow → unstamped; launcher EOA → prepare refuses. Residue as of round 2, stated precisely in the module header at the time: when no prepared record existed, there was no codehash pin — those registrations got the binding checks only and never received launch recognition. **Round 3 supersedes that residue:** a prepared record is now REQUIRED for the stamp (see R3-1).

### R2-3 — Recount scope → swarm-aware, checkpointed, and honest about gaps

- The recount replay (`src/lib/recount.ts`) now applies the recorded **swarm verdict as a seventh rule**: on swarm-gated grants, a push whose recorded fingerprint/quorum outcome is below quorum, FAIL-vetoed, or duplicate-flagged does not count in the recount, and the recount never resurrects a swarm-blocked push. A swarm-gated fixture history is in the suite.
- **Checkpoints:** the backend persists a recount checkpoint (counted total, seen-SHA set + digest, last counted timestamp, counted-fingerprint registry + digest). A trimmed log (200-entry window) replays on top of the covering checkpoint and certifies only if it lands exactly on the live counter. With **no** covering checkpoint, the recount returns an explicit **INCOMPLETE refusal** — it never emits an estimated total.
- Revised claim, used everywhere: **the recount matched the webhook total for the tested histories (plain and swarm-gated); incomplete history without a checkpoint is refused, not estimated.** Suite: **18 PASS / 0 failures** (adds swarm-gated equality, checkpointed-trim equality, no-checkpoint refusal to the original 11).

### R2-4 — Concurrency beyond one SHA; tranche baseline; fee-release retry

- **Atomic cap + cooldown for different SHAs:** the Lua claim in `recordVerifiedPush` now returns distinct conflicts (-1 duplicate, -2 daily-cap, -3 cooldown) with the cap check-and-increment and the cooldown stamp inside the same atomic step. New suite cases: two different SHAs racing for the last daily slot → exactly one counts; two different SHAs inside the cooldown window → exactly one counts. Suite: **11 PASS / 0 failures**.
- **Tranche baseline provenance:** `FeeStreamEscrow.addFeeTranche` takes `expectedBaseline` and **reverts** unless it equals the escrow's authoritative counted total (`knownPushCount`) at lock time; the keeper reads the total immediately before locking. Proven in `tests/fee-baseline-test.ts` (stale baseline reverts; correct baseline locks) and inside the fee-lock suite. (Round 3 extends this with `backendCountAtLock` — see R3-3.)
- **Fee-release retry:** when a supply release succeeds and the fee release fails, `src/oracle/feeLock.ts` records a durable pending-fee-release entry (Redis, indexed). It is retried (a) automatically on the next counted push for that grant and (b) by the keeper sweep (`scripts/fee-release-sweep.ts`); success clears the entry. The supply release is never re-run by a fee retry (its own idempotency keys stand). Proven with a fail-once fixture: supply paid once, fee pending, sweep retries, fee lands exactly once, supply balance unchanged. Fee-lock suite now **68 PASS / 0 failures**.

### R2 wording edits

- WETH is described as "denominated in WETH, so its fiat value still moves with ETH" — the words "stable" / "no price exposure" are removed everywhere.
- PODX is unlinked from the production proof: PODX can demonstrate a live release against the existing v1 dust lock only; the production proof requires a new launch and a v2 grant (owner step 4, reworded accordingly).

## Round-3 response — HOLD THE BETA (2026-11-25, third fix pass)

The round-3 review of the pushed round-2 source (`b409ab38`) held the beta on four release blockers plus doc corrections. All four blockers are fixed in this snapshot, with the reviewer's exact cases as tests. Local code/tests/docs only — no new mainnet actions, no deploys this pass.

### R3-1 — Registration could stamp without a prepared launch → prepared record REQUIRED, lookup errors fail closed, lock event must match

**What was wrong.** With no prepared record and no vault in the request, registration skipped the recipient/vault checks and could stamp on ordering alone; a prepared-record lookup error was caught and treated as "no record"; and `lockTxInfo` extracted a repoId + timestamp from the receipt without matching the `Locked` event's repo/recipient/token to the registration request.

**What changed** (`src/api/register.ts`, `src/lib/launchRecognition.ts`):
- Verified recognition now **requires** a prepared-launch record for the repo+wallet+chain. No record → the grant still registers as an ordinary unstamped grant, with an explicit `launchVerification: {stamped:false, code:"LAUNCH_NO_PREPARED_RECORD"}` in the response — never a stamp, never silent.
- A lookup **error** fails closed with `LAUNCH_PREPARED_LOOKUP_FAILED` (the `.catch(() => null)` swallow is deleted). Proven by fault injection: the fake-Redis stub can be toggled to error on prepared-launch GETs, and registration withholds the stamp (gate suite step 28).
- The prepared record stores the verification lineage at prepare time (GitHub login, token nonce, token issued-at, chainId). Registration requires the presented token to bind to it: same login/repo/wallet/chain, and either the same nonce or a **chained** fresh token (see the token-expiry path below). Chain mismatch → `LAUNCH_PREPARED_CHAIN_MISMATCH`; unchainable nonce → `LAUNCH_PREPARED_NONCE_MISMATCH`.
- `lockTxInfo` now returns the `Locked` event's recipient and token as well as its repoId, and registration compares all three against the request (event repoId vs the request repo's id, event recipient vs the request recipient, event token vs the request token) before any stamp: `LAUNCH_LOCK_REPO_MISMATCH` / `LAUNCH_LOCK_RECIPIENT_MISMATCH` / `LAUNCH_LOCK_TOKEN_MISMATCH` (fee-lock suite steps 34–36, one per field).
- **Token-expiry path (also a BETA.md correction):** the 15-minute token covers the interactive steps; if it expires between launch and registration, the tester re-verifies and registers with the FRESH token. Registration binds to the ORIGINAL prepared record — the fresh token chains when it was issued to the same login/repo/wallet/chain at or after the original verification — and ordering is judged against the ORIGINAL verification time, so a lock made after the original verification is not failed for predating the fresh token (gate suite step 29 proves exactly this: lock predates the fresh token, grant still stamps). A token issued BEFORE the preparation can never chain to it (step 30).
- Tests: gate suite steps 18 (happy path now goes through prepare-launch), 27 (no prepared record), 28 (lookup fault), 29 (chained token), 30 (stale token); fee-lock suite steps 34–36 (event mismatches). Gate suite: **77 PASS / 0 failures**.

### R3-2 — Vault codehash pin proved continuity, not identity → canonical implementation + registrar-only, binding-validated grant registration

**What was wrong.** Prepare-launch pinned whatever codehash the supplied contract happened to have — any contract could be "the vault" if it was supplied first — and `FeeStreamEscrow.registerFeeGrant` was first-caller-wins: the first caller for a repoId became the recipient, with no authorization or binding check.

**What changed.**
- **Canonical implementation** (`src/lib/launchRecognition.ts`): there is ONE approved FeeLockVault implementation. Because the vault's immutables are embedded in its deployed code, a raw codehash differs per project; identity is the **masked-template hash** — the runtime code with the immutable slots (offsets from the compiler's `immutableReferences`) zeroed, then keccak256. The template parameters are embedded in the module (env-overridable via `APPROVED_FEE_LOCK_VAULT_CODEHASH`) and guarded by `tests/vault-impl-test.ts`, which recomputes them from the compiled artifact and fails if the contract source drifts from the constant. Prepare-launch REJECTS a vault whose masked hash differs (`LAUNCH_VAULT_NOT_APPROVED_IMPL`) and pins the canonical hash; registration compares the presented vault's masked hash against it (the existing `LAUNCH_VAULT_CODEHASH_MISMATCH` code now means "not the approved implementation"). Two genuine vaults with different bindings share the canonical hash; the same-getters impostor does not (vault-impl suite, **ALL PASS** — 9 checks). A factory would make provenance cleaner still; it is noted as future work and deliberately NOT built this pass.
- **Registrar-only registration** (`contracts/FeeStreamEscrow.sol`): `registerFeeGrant(repoId, recipient, token, vault, pushesPerTranche)` is `onlyOwner` (the escrow owner is the registrar, set at deploy — the same key pattern as the family's other privileged calls). First-caller-wins is deleted. Registration validates on-chain: vault's `escrow()` == this contract, `launcher()` == recipient, `repoId()` == the grant repo, `feeToken()` == token, no zero addresses. Tests: non-owner caller reverts, wrong-repo vault reverts, wrong-launcher vault reverts, happy path stores the exact fields (`tests/fee-baseline-test.ts` + a non-owner case in the fee-lock vault audit). Backend/fixture call sites updated to the registrar key.
- One honest residue: the vault's `claimLedger` immutable is inside the masked slots and is not compared to a configured value. A vault built from the approved code with a hostile claim ledger can at worst refuse to claim — the code's only outbound path is into its own escrow — never redirect funds.

### R3-3 — Tranches could vest against pre-lock work → keeper pending-report gate + `backendCountAtLock`

**What was wrong.** A tranche's baseline was the last ON-CHAIN oracle report. A push counted in the BACKEND whose fee report was still pending retry had not advanced the on-chain counter, so a tranche locked in that gap would vest against that already-counted push once the report landed. The existing stale-baseline test covered only an on-chain counter change.

**What changed (both halves).**
- **Keeper gate** (`scripts/fee-lock-keeper.ts`): before moving ANY funds for a vault (the gate runs ahead of the claim leg), the keeper checks the durable pending-fee-release store for the grant. A pending entry → it defers (logs `lockDeferred`, moves nothing); the sweep retries the report first. If the store is configured but unreachable, it also defers (fail-closed). Only with `REDIS_URL` unset (standalone local mode) does it proceed without the backend counter, and it records that in its output.
- **Contract** (`contracts/FeeStreamEscrow.sol`, `contracts/FeeLockVault.sol`): `addFeeTranche` / `lockAccrued` take `backendCountAtLock` — the backend's counted total the keeper reads from the backend counter at lock time. The tranche's effective baseline is **max(on-chain total, backendCountAtLock)**, and the backend count is stored on the tranche and emitted in `FeeTrancheLocked`. The invariant is written in the contract header: a tranche can never vest against a push counted before it locked, in either counter.
- **The reviewer's exact case, as tests:** contract level (`tests/fee-baseline-test.ts`) — on-chain counter 2, backend counter 5, tranche locked with `backendCountAtLock=5` is stamped baseline 5; the report landing at 5 vests nothing for it; push 6 vests half. System level (fee-lock suite steps 29–33) — push 7 counted in the backend with its fee report forced to fail (pending recorded, on-chain counter still 6); keeper attempts a lock → DEFERRED, no funds move, no tranche created; sweep lands the report (on-chain 7); keeper locks tranche 4 with baseline/backendCount 7; push 8 half-vests it (+10 WETH, recipient 90 → 100).

### R3-4 — `releaseFee` scanned all tranches forever → settled cursor

**What was wrong.** Every `releaseFee` call iterated every tranche ever locked, including fully-paid ones; cost grew without bound over a grant's life.

**What changed** (`contracts/FeeStreamEscrow.sol`): each grant keeps a `settledCursor` — the index of its first not-fully-vested tranche. `releaseFee` resumes there; fully-vested tranches are never rescanned. The cursor is pinned at the first partially-vested tranche even when a call scans past it to drain a later tranche's backlog delta (a repeat call at the same total advances one more tranche instead of stalling), and the scan stops at the first tranche whose baseline the report has not reached (baselines are non-decreasing in lock order). One timing consequence, stated plainly: when several tranches are mid-vesting under the same report, a call pays up to and including the first not-fully-vested tranche; the remaining tranches' deltas for that report are paid by the next `releaseFee` call. Every tranche's lifetime total is identical to a full scan.
- Test (`tests/fee-cursor-test.ts`, **ALL PASS**): cursor stays at a partially-vested tranche; a same-total repeat pays the next tranche's half; lifetime totals exact (3 WETH over 3 tranches); a long-lived grant with **60 tranches** fully vested — the final no-op `releaseFee` call's `gasUsed` is **38,530**, vs **173,268** for a paying call made when only 2 tranches existed (bound asserted: final < 2× early; under the old full scan the final call would have iterated all 60 settled tranches).

### R3 doc corrections

- **BETA.md Step 4 rewritten:** the PLATFORM deploys the per-project vault (from the approved implementation) during onboarding and the backend registrar registers the fee grant; the tester supplies neither. The token-expiry path above is documented there in tester language.
- **Trust model (BETA.md + here):** the earlier "no admin who can move your tokens" wording is replaced. Accurate model: no cancel, no recipient exit — but the platform owner can rotate the oracle, and the oracle supplies the push counts that authorize releases. A compromised or malicious oracle is a named trust assumption (it cannot redirect tokens — releases pay only the grant's recipient on the lock-time schedule — but it could report counts that did not happen; recovery recounts check reported counts against the recorded push log).
- **Outside launches:** "no verified-launch recognition" replaces "no counting and no rewards" — ordinary locks and grant-less authors still count and earn through their own paths.
- **Deployment scope:** "nothing deployed" is scoped to PRODUCTION everywhere in this document, with the Base-mainnet dust deployments named (status paragraph + R2-1, now with FULL untruncated tx hashes).
- **v1/v2 full disclosure:** with the contract name normalized, the ONLY differences between `contracts/GitEscrow.sol` (v1) and `contracts/GitEscrowV2.sol` (v2) are: (1) the header comment (v2's states the no-cancel rule and oracle-rotation recovery; v1's lists cancel as a feature); (2) the `Cancelled(bytes32,address,uint256)` event — present in v1, removed in v2; (3) the `cancel()` function — present in v1, removed in v2. The contract is renamed `GitEscrow` → `GitEscrowV2`, and EVERY revert string's prefix changed accordingly (`"GitEscrow: …"` → `"GitEscrowV2: …"`) with otherwise identical text; v1's cancel-only string `"GitEscrow: not recipient"` has no v2 counterpart. No other logic differs (verified by direct diff of the two sources with the name normalized).

## Source manifest (sha256 prefix + lines — verify the snapshot you received matches)

| sha256 (first 16) | Lines | File |
|---|---|---|
| `3558d8d10631b45b` | 177 | `contracts/FeeLockVault.sol` |
| `adadb12e5713c001` | 381 | `contracts/FeeStreamEscrow.sol` |
| `c05829af5c3ae5ad` | 360 | `contracts/GitEscrowV2.sol` |
| `e9cc709b1ea5b675` | 362 | `src/lib/recount.ts` |
| `184cda23158946db` | 341 | `src/lib/launchRecognition.ts` |
| `a2cd209d9dca347a` | 297 | `src/api/launchVerify.ts` |
| `ed74b54c3f43f980` | 551 | `src/api/register.ts` |
| `0ae915bb9b5e4057` | 196 | `src/oracle/feeLock.ts` |
| `fc8227f0cb68c433` | 427 | `src/github/pushVerifier.ts` |
| `3bb06a790d2012fa` | 421 | `src/github/processPush.ts` |
| `602f9276cc501d58` | 393 | `src/lib/launchGate.ts` |
| `3b48a2018dd61e31` | 196 | `src/lib/launchFeeConfig.ts` |
| `8aa81a93919f31dd` | 138 | `src/lib/env.ts` |
| `9eac999ace0677bc` | 203 | `scripts/fee-lock-keeper.ts` |
| `ab450e7b52ad90e6` | 475 | `tests/e2e/run-fee-lock.sh` |
| `af093e068d391f39` | 184 | `tests/e2e/run-recount.sh` |
| `db6701ac17fb096a` | 189 | `tests/e2e/run-concurrency.sh` |
| `c080575e9dd543c5` | 474 | `tests/e2e/run-launch-gate.sh` |
| `efc931f1ec0e06c9` | 209 | `tests/fee-baseline-test.ts` |
| `b04b4e7a6b841601` | 121 | `tests/vault-impl-test.ts` |
| `a03eb93717dd2a1d` | 163 | `tests/fee-cursor-test.ts` |

## Test inventory (2026-11-25, local — exact counts)

| Suite | Proves (short) | Result |
|---|---|---|
| `tests/e2e/run-fee-lock.sh` | Fee-lock loop + vault audit (incl. registrar-only `registerFeeGrant`) + prepare-launch gate/split + tranche baseline provenance + fee-release fail-once retry + round-3: keeper pending-report deferral (reviewer's exact gap), lock-event repo/recipient/token mismatch | **106 PASS / 0 failures** |
| `tests/e2e/run-recount.sh` | Recount = webhook total for the tested histories (plain + swarm-gated); checkpointed trimmed log; incomplete history refused; backup-oracle recovery release | **18 PASS / 0 failures** |
| `tests/e2e/run-launch-gate.sh` | Gate refusals (installed/owner/linked), token binding (repo/wallet/chain/expiry/no-issuance-record), intentional TTL reuse, stamped vs unstamped registration, ordering both directions incl. fail-closed unprovable, recognition binding (vault implementation/bindings, launch recipients match, v2-escrow destination, launcher-position EOA refused) + round-3: no-prepared-record unstamped, prepared-lookup fault fail-closed, chained fresh token stamps, pre-preparation token refused | **77 PASS / 0 failures** |
| `tests/e2e/run-launch-exclusions.sh` | Unstamped grant excluded from listing/enrolment, before and after a counted push (verified leg now via prepare-launch) | **14/14 PASS** |
| `tests/e2e/run-concurrency.sh` | Concurrent duplicate webhooks count exactly once (atomic Lua claim); different-SHA daily-cap race and cooldown race each count exactly one | **11 PASS / 0 failures** |
| `tests/fee-baseline-test.ts` | FeeStreamEscrow tranche baseline: stale expectedBaseline reverts, correct baseline locks; round-3: registrar-only + binding-validated `registerFeeGrant`, `backendCountAtLock` exact case (on-chain 2 / backend 5 → baseline 5, report at 5 vests nothing, push 6 half) | **ALL PASS** (20 checks) |
| `tests/vault-impl-test.ts` | Canonical FeeLockVault implementation: embedded template constant == compiled artifact; two differently-bound genuine vaults share the canonical masked hash; same-getters impostor does not (round-3, new) | **ALL PASS** (9 checks) |
| `tests/fee-cursor-test.ts` | `releaseFee` settled cursor: partial vesting pins the cursor, same-total repeat drains the next tranche, lifetime totals exact, 60-tranche grant's final no-op release gasUsed 38,530 < 2× the early 2-tranche paying call's 173,268 (round-3, new) | **ALL PASS** (12 checks) |
| `tests/e2e/run-swarm.sh` | Swarm gate: no/below-quorum → not counted; self-review refused; 2 PASS → counted, author + both reviewers paid; duplicate diff never counts; replay never double-pays | **36/36 PASS** |
| `tests/e2e/run-rewards.sh` | Grant-less author rewards, pending accrual on unlinked authors, no double-pay on replay/re-link | **28 PASS / 0 failures** |
| `tests/e2e/run-attestation.sh` | Ship reports: reported → paid/rejected/expired; reports never settle | **0 failures** |
| `tests/e2e/run-pr-credit.sh` | PR-credit to the author with real line counts; bot PR rejected | exit-clean |
| `tests/e2e/run-e2e.sh` | Core loop: counted push → milestone release; docs-only rejected; reward pays exactly once | exit-clean |
| `tests/e2e/run-mcp-remote.sh` | Remote MCP: tools/list parity across transports (13 tools incl. `verify_github`, `prepare_launch`) | **ALL PASS** |
| `tests/launch-fee-config-test.ts` | 25/75 template: exact recipients, vesting `{bps: 0}` present, fail-closed without treasury, vault-as-launcher-share wiring | **9/9 PASS** |
| `tests/v2-nocancel-test.ts` | GitEscrowV2: no cancel in ABI, cancel attempts revert, recipient cannot release, oracle rotation + release | PASS |

Notes on method: the E2E suites run the real backend, verifier, oracle, and contracts against a local Hardhat chain (chainId 8453), a fake-Redis stub, and a fixture GitHub API — not mocks of the platform's own logic. Known limits: real-Redis semantics and live api.github.com behavior are not covered by these suites (the raw-push webhook path did run live once, 2026-11-24, against a real repo; PR-credit and installation lookups remain fixture-only).

## Remaining owner-only steps

These are operational steps that cannot be done in local code. Nothing else is open: every gap found in all three review rounds has been fixed in code+test (round 2: see "Round-2 response" above; round 3: see "Round-3 response"), and the denomination decision is made (step 6).

1. **Designate `PLATFORM_REWARD_TREASURY_WALLET`** — a dedicated claim-capable wallet for the 25% reward-treasury share. Until it is set, platform launch inputs cannot be built (fail-closed by design; no address has been invented for it).
2. **Deploy GitEscrowV2 + FeeStreamEscrow** (and a FeeLockVault per project at launch time). V2 is not deployed anywhere; the mainnet lock proof used v1, which has recipient cancel.
3. **Redeploy the backend** with the GitHub App credentials + `SESSION_SECRET` configured — the gate, prepare-launch, swarm, fee-lock, and recount code go live only then.
4. **Install the App on a real repo and make a live push** — the end-to-end proof that has never run: verification → production launch → v2 lock → counted push → payout. (The PODX grant is a v1 dust lock; it can demonstrate a live release against v1 only. The production proof requires a NEW launch and a v2 grant.)
5. **Set the production reward schedule** — the flat base per-merge author reward, the reviewer share (code default is a labelled placeholder: 10% of the base reward), and the platform reward token's name/ticker (spec placeholders $PROOF / $SHIP; ShipRewards pays a mock token in tests, and the fee-recycle loop cannot operate until the real token exists).
6. **Fee denomination — decided: WETH for the first launch** (Gregory, 2026-11-25). The project-token swap path stays deferred until built and tested; nothing about the first launch waits on it.

## Review asks

- **Any path where fees or supply reach a launcher without counted pushes.** Trace every outbound transfer in `FeeLockVault` and `FeeStreamEscrow`, every caller of `addFeeTranche` / `releaseFee`, and the backend's fee-release hook in `processPush.ts`. Include the keeper: can it be made to lock to a different grant, or claim to a different beneficiary?
- **Vault outbound-path audit.** The claim is: state-changing surface is exactly `claimFees` + `lockAccrued`, the escrow is the only possible destination, and no admin/owner function exists. Verify against the compiled ABI and bytecode, including the `forceApprove` inside `lockAccrued`.
- **Recount equivalence holes.** `src/lib/recount.ts` recomputes acceptance from recorded log fields. Find a recorded history where the replay and the live verifier disagree — especially: PR-credit pushes (pusher normalised to the author; real line counts recorded), substantial-change cooldown bypasses near the boundary, entries straddling midnight for the daily cap, and any rejection shape whose recorded fields cannot establish the live path's reason (force-push and branch rejections record no line estimate — the replay treats them as unproven; is that always conservative?).
- **Gate bypass on the new launch-prep surface.** `POST /api/launch/prepare-launch` must refuse every token failure the lock endpoints refuse (repo/wallet/chain binding, expiry, no issuance record) and must never emit a launch input with the launcher share to a raw wallet or with vesting omitted. Check the handler's wallet source (header vs body) for a binding mismatch against the token.
- **Ordering fail-closed edge cases.** Registration stamps only on a proven lock timestamp >= token `iat` from the registration tx itself. Probe: a lock tx from a *different* repo/grant presented at registration; a `Locked` event from a different escrow contract on the same chain (register reads the chain's configured escrow receipt — check `lockTxInfo`'s log parsing); block-timestamp granularity vs the token's wall-clock `iat` on a fast chain.
- **Swarm and verifier, as before.** Any counting hole (the 5-lines-per-file estimate, fingerprint collisions, second-login/same-wallet independence holes, reviewer double-pay on replay) that pays out on non-work — now including whether a swarm-gated push's fee tranches can release while its supply release is blocked, or vice versa.
- **Docs vs code.** Anything in `LAUNCH-GATE.md`, the skills, or `docs/agent.md` that describes the fee-lock, the launch-prep surface, or the recount as live/deployed behavior rather than built-locally, or that states a number this document's test table does not support.
- **Round-3 mechanisms, new in this snapshot.** (a) The chained-token lineage: can a fresh token be chained to a prepared record it was not issued for (different wallet that later re-links, a second preparation overwriting the first, clock skew between issuance and the lock's block time)? (b) The masked-template vault identity: is there a contract that shares the masked hash without being the approved implementation (e.g. same code, hostile constructor-set state beyond the immutables), and does the un-compared `claimLedger` immutable open anything beyond claim refusal? (c) The release cursor: construct a tranche sequence where the pinned-cursor scan pays a different lifetime total than a full scan, or where the cursor can be left pointing at a settled tranche. (d) The keeper gate: a pending entry written for a DIFFERENT repoId form (case/prefix) than the keeper computes would silently not defer — check the key derivation on both sides.
