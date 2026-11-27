# Multi-Lock Design — Multiple Concurrent Grants per Repo (GitEscrowV3)

Status: **DESIGN ONLY** (Gregory's order, 2026-11-27: "it should allow
multiple locks on the same repo" → "Design multi lock support"). No
contract code, no deploys, no skill edits in this run. This document is
written to be built from without further design work.

## Why

Today `GitEscrowV2` keys grants by repo alone:

```solidity
mapping(bytes32 => VestingGrant) public grants;   // repoId → grant
require(!grants[repoId].active, "GitEscrowV2: repoId already active");
```

Every lock path (`lock`, `lockAllowance`, `lockWithPermit`) reverts
while a grant is active on the repo, and the backend mirrors the rule
(`register.ts` returns 409 "Active vesting grant already exists for
this repo"). This was proven live on 2026-11-27: Bankr, running the
v5.1 skill correctly, prepared a second POD lock (50% of Gregory's
balance, 50 pushes) on `anondevv69/github-vesting` and could not
submit it because Gregory's 100-push POD grant is active on that repo
in GitEscrowV2. Gregory's decision: a repo must be able to carry
several concurrent locks — different amounts, tokens, recipients, and
schedules — each vesting on the repo's counted pushes.

---

## DECISIONS FOR GREGORY

Each item has a recommendation. Nothing in the build phase should
re-litigate these without coming back here.

1. **Counting semantics — one repo counter, per-grant baselines.**
   *Recommendation: ADOPT the model in §2.* The oracle's counted-push
   total stays repo-scoped and cumulative (the webhook / verifier /
   swarm / recount pipeline is untouched). Each grant records the
   repo total at its own lock time (`startPushCount`) and vests only
   on pushes counted after it. This is the same baseline pattern
   `FeeStreamEscrow` already runs in production for fee tranches, so
   it is a proven shape in this codebase, not a new invention. The
   alternative — an independent counter per grant — would fork the
   recount, the checkpoints, and the swarm gate per grant and is
   rejected in §2.4. Sub-decision folded in here: the on-chain
   baseline is stamped from the oracle-advanced `knownPushCount`
   (§2.3), not from any caller-supplied number; the strict
   attestation variant is specified there as a drop-in hardening if
   review demands it.
2. **Concurrent-grant cap per repo — 10 active grants.**
   *Recommendation: cap ACTIVE grants per repo at 10, enforced
   on-chain.* Real use today needs 2 (Gregory's repo). The cap is an
   operations bound, not a contract-gas bound: `release()` is called
   per grant, so no single transaction loops over grants; what grows
   with grant count is the backend's per-counted-push work (at most
   one release transaction per grant with a milestone due) and the
   keeper sweep's per-repo reads. 10 bounds a counted push to at most
   10 release transactions and a sweep pass to 10 `eth_call`s per
   repo, while leaving generous headroom. Completed grants do not
   count against the cap.
3. **FeeStreamEscrow multi-grant — DEFERRED, not in the first build.**
   *Recommendation: defer.* Fee grants have the same one-per-repo
   keying (§3), but a fee grant's identity is a project's single fee
   stream (one launch → one FeeLockVault → one recipient per repo);
   supply multi-lock creates no second fee stream, and `releaseFee`
   already operates on the repo cumulative count with per-tranche
   baselines. Nothing in the multi-lock build needs to touch it.
   Revisit only if a repo ever hosts two launches' fee streams.
4. **Schedule divisibility — keep V2's rule.** `totalPushes %
   pushesPerMilestone == 0` stays a lock-time requirement (§2.5).
   Non-divisible schedules (a smaller final milestone) are a possible
   V3.1 change and are explicitly out of scope here.

---

## 1. CONTRACT — GitEscrowV3

New contract `contracts/GitEscrowV3.sol`. V2 is **not** modified:
live V2 grants (Gregory's 100-push POD grant, the completed pilots)
stay on V2 and keep releasing exactly as today (§4.2). V3 is a fresh
deployment with the same owner and oracle keys as V2.

### 1.1 Grant identity

```solidity
/// Per-repo grant nonce: number of grants ever created for a repo.
mapping(bytes32 => uint256) public grantNonce;        // repoId → next nonce
/// Per-repo ACTIVE grant count (the §Decision-2 cap counter).
mapping(bytes32 => uint256) public activeGrantCount;  // repoId → active grants
/// Enumeration: every grantId ever created for a repo, in lock order.
mapping(bytes32 => bytes32[]) public repoGrantIds;    // repoId → grantId[]
/// The grants themselves, keyed by grantId.
mapping(bytes32 => VestingGrant) public grants;       // grantId → grant
```

`grantId` is derived inside every lock path, identically:

```solidity
bytes32 grantId = keccak256(abi.encode(repoId, msg.sender, token, grantNonce[repoId]));
grantNonce[repoId] += 1;
```

Properties the rest of the system relies on:

- **Unique per (repo, recipient, token, creation order)** — two
  grants by the same recipient in the same token on the same repo
  (Gregory's exact case) differ by nonce alone.
- **Predictable**: given the repo's current on-chain nonce, anyone
  (backend prepare-lock, an agent, the frontend) can compute the
  grantId the next lock will get. Prediction is advisory only —
  confirm/registration always resolves the real grantId from the
  `Locked` event (§4.3), because a competing lock could consume the
  nonce first.
- **Stable forever**: a grantId never changes and is never reused,
  including after the grant completes.

### 1.2 Grant struct — V2 fields plus two

```solidity
struct VestingGrant {
    bytes32 repoId;          // NEW: the repo this grant belongs to
    address recipient;       // V2, unchanged
    address token;           // V2, unchanged
    uint256 totalLocked;     // V2, unchanged
    uint256 totalReleased;   // V2, unchanged
    uint256 totalPushesRequired;  // V2, unchanged
    uint256 pushesPerMilestone;   // V2, unchanged
    uint256 tokensPerMilestone;   // V2, unchanged
    uint256 lastPaidMilestone;    // V2, unchanged
    bool active;                  // V2, unchanged
    bool streaming;               // V2, unchanged
    uint64 lockedAt;              // V2, unchanged
    uint256 startPushCount;  // NEW: repo cumulative counted total at lock time (§2)
}
```

### 1.3 What carries over from V2, unchanged in behaviour

- `lock(repoId, token, amount, totalPushes, pushesPerMile)` — same
  parameters, same validation (zero token/amount, push params,
  `pushesPerMile <= totalPushes`, divisibility, `tokensPerMile > 0`),
  same pre-funded pull via `_tryPull` with the same revert directing
  restricted tokens to `lockAllowance`. Differences are mechanical
  only: the `!active` require is replaced by the cap check
  (`activeGrantCount[repoId] < MAX_GRANTS_PER_REPO`), the grant is
  stored under its grantId, `startPushCount` is stamped (§2.3), the
  enumeration structures are updated, and the function **returns the
  grantId** (a return value does not change calldata; existing
  callers that ignore it are unaffected).
- `lockAllowance(...)` and `lockWithPermit(...)` — identical
  treatment: same signatures, same allowance/permit behaviour, same
  mechanical differences, both return the grantId.
- `release(...)` — same oracle-only gate, same milestone maths on
  the grant's own schedule, same final-milestone dust sweep, same
  streaming pull-through-oracle forwarding, same `active = false` on
  final. Its signature and count basis change per §2.2:
  `release(bytes32 grantId, uint256 totalVerifiedPushes)` where the
  total is the **repo cumulative** count.
- `setOracle` / `Ownable` — unchanged. Oracle rotation remains the
  GitHub-death recovery path.
- View helpers, re-keyed: `getGrant(bytes32 grantId)`,
  `remainingTokens(bytes32 grantId)`, `nextMilestoneAt(bytes32
  grantId)` (now returns a repo-cumulative count: `startPushCount +
  (lastPaidMilestone + 1) * pushesPerMilestone`). New views:
  `repoGrantCount(bytes32 repoId)`, `repoGrantIdAt(bytes32 repoId,
  uint256 index)`, `knownPushCount(bytes32 repoId)` (public mapping
  getter, §2.3).

### 1.4 Events

```solidity
event Locked(
    bytes32 indexed grantId,     // NEW primary key
    bytes32 indexed repoId,
    address indexed recipient,
    address token,
    uint256 amount,
    uint256 totalPushesRequired,
    uint256 releasesPerMilestone,
    uint256 tokensPerMilestone,
    uint256 startPushCount       // NEW
);
event Released(
    bytes32 indexed grantId,     // NEW
    bytes32 indexed repoId,
    address indexed recipient,
    uint256 amount,
    uint256 pushMilestone,
    uint256 totalReleasedSoFar
);
event OracleUpdated(address indexed oldOracle, address indexed newOracle); // unchanged
```

The event signature changes vs V2's `Locked`, so registration must
parse the ABI of the escrow that emitted the log — it already selects
logs by escrow address (§4.3); V3 adds the second ABI to that
selection.

### 1.5 The NO-CANCEL rule, carried over verbatim

V3 contains **no `cancel()` and no recipient exit of any kind**, for
the same reason V2 does not (Gregory's rule, 2026-11-25): a lock its
recipient can unwind proves nothing. The V2 header comment stating
the rule is copied into V3 unchanged, and the build's test plan (§7)
includes the same probe as `tests/v2-nocancel-test.ts`: calling the
`cancel()` selector (and `withdraw`/`exit` selectors) on V3 must
revert / have no matching function. Releases happen only via the
oracle on counted pushes; verifier death is recovered by owner
oracle rotation to a backup verifier that recounts from the recorded
push log — never by recipient exit.

### 1.6 The cap

```solidity
uint256 public constant MAX_GRANTS_PER_REPO = 10;
```

Enforced in all three lock paths against `activeGrantCount[repoId]`
(incremented at lock, decremented when a grant's final release sets
`active = false`). The enumeration array `repoGrantIds` grows
without bound over a repo's lifetime by design (it is the audit
trail); only the *active* count is capped, per Decision 2.

---

## 2. COUNTING SEMANTICS

**RECOMMENDATION (Decision 1): adopt the repo-scoped cumulative
counter with per-grant baselines, as specified in this section.**
This is Gregory's decision to confirm; the build proceeds on this
model if adopted.

### 2.1 The one counter

There is exactly one counted-push total per repo: the total the
existing pipeline produces today. The webhook verifier, the
mandatory swarm window (quorum PASS, or expiry fallback), PR credit,
the daily cap, the cooldown, the duplicate-SHA rule — all of it is
repo-scoped today and **none of it changes**. A push counts once for
the repo, or not at all. The Redis counter (`vesting:pushes:{repoId}`),
the push log, and the recount checkpoints stay exactly as they are;
the recount still certifies one repo total (§2.5).

### 2.2 How one counted push settles many grants

Each grant carries `startPushCount` = the repo cumulative total at
the moment its lock landed (§2.3). From then on, the grant's
progress is purely derived:

```
elapsed(grant, repoTotal)        = max(0, repoTotal − grant.startPushCount)
milestonesEarned(grant, repoTotal) = min( floor(elapsed / grant.pushesPerMilestone),
                                          grant.totalPushesRequired / grant.pushesPerMilestone )
releasable(grant, repoTotal)     = milestonesEarned − grant.lastPaidMilestone   (in milestones)
```

`release(grantId, repoTotal)` applies V2's payout maths to
`milestonesEarned` exactly as V2 applied it to its repo-total input:
payout = newMilestones × tokensPerMilestone, final milestone sweeps
any remaining dust, `active = false` at completion. The contract
also advances its own repo counter on every release call:
`knownPushCount[repoId] = max(knownPushCount[repoId], repoTotal)`
(the same monotone-report pattern `FeeStreamEscrow.releaseFee`
already uses).

The backend release step (§4.4) iterates the repo's active grants on
each counted push and calls `release` once per grant that has a
milestone due — V2 grants with V2's grant-relative basis, V3 grants
with the repo-cumulative basis. One counted push can therefore settle
a milestone on several grants in the same processing pass, each in
its own transaction, each paying its own recipient in its own token.

### 2.3 The baseline stamp — who says what the count was at lock time

The contract cannot see the backend's counter, and a caller-supplied
baseline is not acceptable: the recipient locks their own tokens, and
a baseline of 0 supplied at lock time would vest the new grant
against pushes that predated it. (This is the same failure shape
Codex round 4 removed from `FeeStreamEscrow`, where the bare
caller-supplied count was deleted in favour of an oracle-signed
attestation.)

V3 stamps the baseline on-chain, from the oracle's own reports:

```solidity
/// Highest repo counted total the oracle has reported to THIS
/// contract. Advanced only by release() and reportCount().
mapping(bytes32 => uint256) public knownPushCount;
```

- Every lock path sets `startPushCount = knownPushCount[repoId]`.
- `release()` advances it (above).
- A new oracle-only function keeps it fresh when no release is due:

```solidity
function reportCount(bytes32 repoId, uint256 totalVerifiedPushes) external; // oracle only, monotone
```

The backend's counted-push path already runs a per-count hook
(`afterCountedPush` in `src/github/processPush.ts`); the build adds:
*after incrementing the repo counter, if the repo has any V3 grant
and no V3 release call in this pass already carried the new total,
send `reportCount(repoId, newTotal)`.* Cost: at most one extra
oracle transaction per counted push on repos with V3 grants, and
zero on repos without.

Residual window, stated plainly: a lock whose transaction lands
after the backend counted a push but before that push's
`reportCount`/release reached V3 would be stamped with the previous
total and gain credit for that one push. The window is seconds wide,
the beneficiary is the locker themselves accelerating their *own*
vesting by at most the pushes inside it, and the platform's own
prepare → sign → register flow does not time locks against counted
pushes. This bounded risk is accepted by the recommendation.

*Hardening variant (drop-in, not in the first build unless review
requires it):* reuse the existing EIP-712 `CountAttestation` scheme
(`src/lib/countAttestation.ts`, FeeStreamEscrow round 4) — lock
paths take a trailing attestation + signature and stamp
`max(knownPushCount, attestedTotal)` with the same monotone nonce /
floor enforcement, under a V3 domain name. The backend already
issues these attestations for the fee keeper; issuing one at
prepare-lock time is a small addition. If the V3 audit or a Codex
round flags the residual window, this closes it with no other
design change.

### 2.4 Why not a counter per grant

Rejected. The counted total is a property of the repo's push
history, not of any grant: the verifier rules (daily cap, cooldown,
duplicate SHAs), the swarm windows, the push log, and the recount
checkpoints are all built around one sequence per repo. Per-grant
counters would require replaying that machinery once per grant,
would let the same push be "counted" for one grant and not another
under cap/cooldown edge timing, and would make the recount certify
N totals instead of one. The baseline model gets identical vesting
outcomes with zero changes to the counting pipeline — a grant is a
*window over* the repo's one history, not a second history.

### 2.5 Edge cases

- **Grant created mid-stream.** The repo already has, say, 37
  counted pushes (Gregory's repo will have some when his second lock
  lands). The new grant stamps `startPushCount = 37`; those 37
  pushes never vest it. Its first milestone is due at repo total
  `37 + pushesPerMilestone`.
- **Grant completes while others continue.** Its final release sets
  `active = false` and decrements the repo's active count. The repo
  counter keeps rising; the completed grant is skipped by the
  release iteration and `release()` on it reverts ("grant not
  active") if called — the worker must not call it (§4.4). Other
  grants are unaffected: completion is fully isolated per grantId.
- **Two grants, same recipient, different tokens.** Distinct
  grantIds (token is in the hash). Schedules, balances, and releases
  are fully independent. The escrow holds both tokens; per-grant
  accounting (`totalLocked`/`totalReleased`) is the invariant, as it
  already is across repos in V2's shared escrow balance.
- **Same token, different schedules (Gregory's case).** Grant A:
  POD, 100 pushes, 1 per milestone. Grant B: POD, 50 pushes, 1 per
  milestone, locked later at a higher baseline. Each counted push
  after B's baseline is one milestone for A *and* one for B; B
  completes after 50 such pushes while A continues. Escrow POD
  balance is shared; the per-grant accounting invariant is
  `Σ (totalLocked − totalReleased) over POD grants ≤ escrow POD
  balance`, which holds because every lock pulled (or, streaming,
  reserved allowance for) exactly its `totalLocked`.
- **Streaming grants among pre-funded ones.** `streaming` is a
  per-grant flag, exactly as in V2; a streaming grant's releases pull
  through the oracle and forward in the same transaction, a
  pre-funded grant's releases pay from escrow. Mixing modes on one
  repo is supported with no interaction.
- **Divisibility and dust.** Two different "uneven" cases, kept
  distinct:
  - *Schedule*: `totalPushes % pushesPerMilestone != 0` — V2
    reverts at lock ("uneven milestones"); V3 keeps the revert
    (Decision 4). There is no partial final milestone.
  - *Amount*: `amount % milestones != 0` — `tokensPerMilestone`
    floors at lock, and V2's final-milestone rule pays
    `max(computed payout, totalLocked − totalReleased)`, sweeping
    the rounding dust into the last release. Carried over verbatim;
    a grant always pays out exactly `totalLocked` over its life.
  - *Overshoot*: `repoTotal − startPushCount > totalPushesRequired`
    (the repo kept shipping after this grant's schedule ended, or
    several pushes landed between release calls) — milestones clamp
    at the grant's total, exactly as V2 clamps.
- **Recount replay against multiple grants.** The recount is
  unchanged: it replays the recorded push log through the verifier
  rules (+ swarm stamps) and certifies ONE repo total, or refuses.
  Per-grant settlement against a certified total is pure derivation
  (§2.2 formulas): for each active grant,
  `milestonesEarned(recountedTotal) − lastPaidMilestone` milestones
  are releasable. A grant whose `startPushCount` exceeds the
  certified total (impossible in the live flow — a baseline is
  stamped from oracle reports that trail the backend counter, never
  lead it) yields zero releasable and is skipped, never negative.
  `scripts/recount-and-release.ts` iterates the repo's grants and
  releases each on its own basis (§4.4).
- **Author and reviewer rewards are NOT multiplied.** ShipRewards
  pays the PR author once per counted push and reviewers once per
  swarm-counted push, regardless of how many grants vest on that
  push. Multi-lock changes vesting only; the reward path in
  `afterCountedPush` runs once per counted push, as today.

---

## 3. FEE SIDE — FeeStreamEscrow

**Finding: fee grants have the same one-per-repo limit.** In
`contracts/FeeStreamEscrow.sol`:

```solidity
mapping(bytes32 => FeeGrant) public feeGrants;   // repoId → the one fee grant
require(!feeGrants[repoId].registered, "FeeStreamEscrow: already registered");
```

One fee grant per repo, bound to exactly one FeeLockVault, one
recipient, one fee token, one `pushesPerTranche`.

**Recommendation (Decision 3): OUT of scope for the first multi-lock
build — deferred, for these reasons:**

1. **Different identity.** A supply grant is "a lock someone chose to
   create"; a fee grant is "the fee stream of this repo's one
   launch". The platform's launch model produces exactly one launch,
   one vault, and one fee recipient set per repo
   (`launchOnboarding` records are keyed repo+wallet with one vault).
   No current or planned flow creates a second fee stream on a repo.
2. **No mechanical need.** `releaseFee(repoId, repoTotal)` already
   consumes the repo cumulative count and already manages *many*
   baselined tranches under the one grant — the multi-baseline
   problem is solved there. Supply multi-lock neither changes the
   fee grant's inputs nor its schedule.
3. **Blast radius.** Multi fee grants would need grantId keying in
   FeeStreamEscrow, per-grant vault binding validation, per-grant
   attestation nonces/floors (today's `lastAttestationNonce` /
   `lastAttestedTotal` are per-repo), and keeper changes — a second
   contract's worth of audit surface to serve a case that does not
   exist yet.

If it is ever built, the shape mirrors this document: `feeGrantId =
keccak256(repoId, vault, nonce)`, per-grant tranche arrays, per-grant
attestation floors. Noted here so the deferral is a decision, not an
oversight.

---

## 4. BACKEND / API CHANGES

### 4.1 What is hard today (found in the current code)

Multi-grant is not a contract-only change. Four backend assumptions
of one-grant-per-repo must be undone:

1. **The repo counter is reset per grant.** `register.ts` writes
   `vesting:pushes:{repoId} = "0"` at every registration, and
   `GrantRecord.verifiedPushCount` doubles as both the repo counter
   and the grant's progress. With concurrent grants the counter must
   become repo-owned state that registration never resets, and grant
   progress must be derived (`repoCount − startPushCount`).
2. **Registration hard-rejects a second grant** (the 409 above), and
   grant storage is keyed by repoId alone: `vesting:grant:{repoId}`,
   with `vesting:repo_name:{platform}:{name}` resolving a repo name
   to exactly one grant. Every reader — status, lock detail, MCP,
   the release oracle — goes through that 1:1 resolution.
3. **The release oracle's count basis is grant-relative.** V2's
   `release(repoId, total)` interprets `total` from the grant's own
   start (true only because one grant existed per repo).
   `triggerReleaseIfMilestone` computes milestones from
   `grant.verifiedPushCount`. V3 grants need the repo-cumulative
   total and a grantId argument — the oracle needs a per-grant basis
   branch, selected by the grant's escrow version.
4. **Chain config models exactly one legacy escrow.**
   `resolveGrantEscrowAddress` falls back stored → `legacyEscrowAddress`
   → configured. After the V3 repoint there are *two* historical
   escrows (the 2026-11-24 V1 production deployment and V2), and
   `knownEscrowAddresses()` (used when reading lock transactions)
   must know all of them.

### 4.2 Grant records — extend, never migrate

`GrantRecord` gains three fields, all written at registration:

```ts
grantId?: string;        // bytes32 hex; V3 grants only (V1/V2 grants predate grantIds)
startPushCount?: number; // repo cumulative total stamped on-chain at lock; V3 only
escrowVersion?: 1 | 2 | 3; // derived from escrowAddress at registration
```

Storage:

- New key `vesting:grant_by_id:{grantId}` → the `GrantRecord` JSON
  (V3 grants live here).
- New set `vesting:repo_grants:{repoId}` → grantIds of the repo's
  V3 grants.
- Existing key `vesting:grant:{repoId}` keeps holding the repo's
  V1/V2 grant, untouched. A repo can therefore have one legacy grant
  (under `vesting:grant:{repoId}`) **plus** up to 10 V3 grants —
  Gregory's repo will be exactly this: his V2 100-push grant under
  the legacy key, his V3 50-push grant under its grantId.
- New helpers beside the existing ones in `src/lib/redis.ts`:
  `saveGrantById`, `getGrantById`, `listGrantsForRepo(repoId)`
  (legacy grant first if present, then V3 grants in creation order),
  `listAllGrants` extended to union both key spaces.
  `getGrantByRepoFullName` keeps returning ONE grant — defined as
  the **primary grant** (§4.5) — so every existing caller keeps
  working; new code uses `listGrantsForRepo`.

**No migration of live grants.** V2 grants stay V2 grants: their
records, their escrow resolution (stored `escrowAddress` →
legacy → configured, unchanged), their grant-relative release basis,
and their status responses are byte-for-byte the behaviour of today.
V3 is additive everywhere.

### 4.3 prepare-lock / confirm-lock / registration

- **prepare-lock** (`src/lib/lockBuilder.ts`): builds against
  `cfg.escrowAddress`, which the deploy (§9) repoints to V3 — so
  after cutover, prepared locks are V3 locks with no builder logic
  change beyond: the response gains `escrowVersion: 3` and
  `expectedGrantId` (computed from the chain's current
  `grantNonce[repoId]` for the caller's wallet+token; advisory, see
  §1.1). The prepared calldata is V2-shaped (same lock signatures),
  so agents and the wizard submit it unchanged.
- **confirm-lock → registration** (`src/api/register.ts`): 
  - The 409 "active grant already exists" check applies **only when
    the lock's escrow is V1/V2** (where a second lock would have
    reverted on-chain anyway). For a V3-escrow lock it is removed.
  - Locked-event parsing selects the ABI by the emitting escrow
    (V3 ABI for the V3 address, V2 ABI otherwise — the code already
    filters receipt logs by escrow address and already records
    `lockInfo.eventEscrow`).
  - For a V3 lock, registration reads the grant back from chain
    (`getGrant(grantId)`) and records `grantId`, `startPushCount`
    (from chain, never from the request), `escrowVersion: 3`, and
    `escrowAddress` = V3.
  - **The push counter is initialised with SET NX, never reset**: if
    `vesting:pushes:{repoId}` exists (a repo with any prior grant),
    its value is the new grant's counting context and stays. Only a
    repo with no counter at all starts at 0. (For V1/V2 registrations
    this is a no-op change: a repo reaching registration today has
    either no counter or a completed grant whose counter the reset
    was discarding — under multi-lock the counter is repo history
    and is never discarded again. Behaviour for the legacy solo-grant
    flow is preserved because a legacy grant's basis is its own
    record's `verifiedPushCount`, not the shared counter — see
    §4.4.)
  - Launch recognition (the `launchVerified` stamp) is unchanged in
    rule: the lock must sit in the *configured* escrow — after
    cutover, that means V3 — and the fee-vault binding checks key off
    the registration as today.

### 4.4 Release path — worker, sweep, keeper

- `triggerReleaseIfMilestone` gains a basis branch on
  `grant.escrowVersion`:
  - **V1/V2 grants**: exactly today's call — `release(repoIdBytes,
    grantRelativeTotal)` against `resolveGrantEscrowAddress(grant)`.
  - **V3 grants**: milestones computed as
    `floor((repoTotal − grant.startPushCount) / pushesPerMilestone)`
    clamped to the grant's total; call `release(grantId,
    repoTotal)` against the V3 escrow. The existing fail-loud checks
    carry over (escrow has code; receipt's `Released` event parsed
    for the payout — the V3 event adds grantId, the parser selects
    the ABI by escrow as in §4.3).
  - Per-grant bookkeeping (`lastPaidMilestone`, `status`) is updated
    on the grant's own record (by grantId for V3, by repoId for
    legacy — `updateGrant` gains an by-id twin).
- `afterCountedPush` (webhook + swarm settler): the repo counter
  increments once (unchanged); the author reward and fee release run
  once (unchanged); the supply-release step becomes a loop over
  `listGrantsForRepo(repoId)` filtered to `status === "active"`,
  calling the branched release for each. A failure on one grant is
  logged and does not block the others or the fee step (today's
  step-isolation style). Then the §2.3 `reportCount` obligation: if
  any V3 grant exists on the repo and no V3 release in this pass
  carried the new total, the oracle sends `reportCount`.
- **Sweep** (`scripts/fee-release-sweep.ts` — fee side, unchanged;
  and `scripts/recount-and-release.ts`): the recount script iterates
  `listGrantsForRepo` and releases each grant against the certified
  repo total on its own basis, instead of resolving one grant per
  repo. The pending-fee-release machinery is repo-scoped and
  untouched.
- **Keeper** (`scripts/fee-lock-keeper.ts`): unchanged — it serves
  FeeStreamEscrow, which is out of scope (§3).

### 4.5 Status endpoints — new shapes, back-compatible

The primary-grant rule, used wherever a single grant must be
returned: **the earliest-created ACTIVE grant for the repo; if none
is active, the most recently created grant.** (For every repo that
exists today this returns exactly the grant it returns now.)

- `GET /api/vesting/status?repo=owner/repo` and
  `GET /api/vesting/status/:repoId` (`src/api/status.ts`): response
  gains a `grants` array — one entry per grant:
  `{ grantId, escrowVersion, escrowAddress, recipient, token, chain,
  totalLocked, totalPushesRequired, pushesPerMilestone,
  tokensPerMilestone, startPushCount, verifiedPushCount (grant-
  relative progress), lastPaidMilestone, status, onChainTxHash,
  progress }` — alongside the existing top-level `grant` (the
  primary grant, unchanged shape), `progress`, and `recentPushes`.
  Existing consumers see a superset.
- `GET /api/vesting/lock/:owner/:repo` (`handleLockDetail`, the
  LockPage's endpoint): same treatment — existing fields stay,
  `grants` array added; `?grantId=` selects which grant is the
  detailed one.
- New: `GET /api/vesting/grant/:grantId` — one grant's full record +
  progress, for agents and support tooling.
- `buildProgress` (`src/lib/grantsHelper.ts`) takes the
  grant-relative count as an input instead of reading
  `grant.verifiedPushCount` as the repo total: for V3 grants the
  caller passes `repoTotal − startPushCount`; for legacy grants it
  passes the record's count as today. `nextMilestoneAt` is reported
  grant-relative in `progress` (as consumers expect today) and the
  status payload's per-grant entry additionally carries
  `nextMilestoneAtRepoTotal` for V3 grants.

### 4.6 Chain config

`src/lib/chains.ts`:

- `knownEscrowAddresses(key)` returns configured + **all** historical
  escrows for the chain. Base gains `GIT_ESCROW_V2_ADDRESS` (env) as
  a second historical entry beside `GIT_ESCROW_LEGACY_ADDRESS`.
  `resolveGrantEscrowAddress` is **unchanged** — stored-address-first
  resolution already does the right thing for every existing grant,
  and §19's warning stands: the legacy env values are set explicitly
  in production and never hardcoded.
- A helper `escrowVersionOf(chain, address): 1 | 2 | 3 | null` maps
  an address to its version from the same config (legacy env → 1,
  V2 env → 2, configured → 3 post-cutover; pre-cutover the configured
  V2 address maps to 2 — the mapping is by address identity, not by
  "current-ness", so it stays correct across the repoint).

---

## 5. FRONTEND

- **`/lock/{owner}/{repo}`** (`frontend/src/pages/LockPage.tsx`): the
  page keeps its current layout for the primary grant (hero progress,
  schedule, recent pushes — unchanged, fed by the back-compatible
  fields). Below it, when `grants.length > 1`, a **"All locks on
  this repo"** section renders one card per grant: token symbol,
  recipient (shortened), locked / released amounts, per-grant
  progress bar and `x of y pushes` (grant-relative), milestone size,
  status chip (active / complete), escrow version badge (V2 / V3),
  the grantId (shortened, click-to-copy in full), and a Basescan
  link to the grant's lock transaction. Selecting a card swaps the
  detail view to that grant (driven by the `?grantId=` parameter in
  §4.5, so a grant card is shareable by URL).
- **Launch wizard / create flows**: no changes. They submit whatever
  transactions prepare-lock returns; after the §9 cutover those are
  V3 transactions with identical signatures. The one visible
  difference: the create flow's "a lock already exists on this repo"
  copy (sourced from the registration 409) no longer appears for
  repos whose active grant is a legacy grant — a second lock is now
  a normal flow, and the wizard's post-lock status link lands on the
  multi-grant lock page above.
- **Vesting status / explore pages** consume the same endpoints and
  inherit the superset responses without changes; per-grant rows in
  lists key by `grantId ?? repoId`.

---

## 6. SKILL / MCP DELTAS (specify only — not implemented here)

- **Skill (bankr-vesting / claude-vesting)**: the v5.2 note "one
  active lock per repo — a second lock needs a different repo" is
  **deleted** and replaced with the multi-grant behaviour: an agent
  may prepare and submit an additional lock on a repo with active
  grants; it must expect a `grantId` back from confirm-lock and use
  it in follow-up status queries; the escrow-identity check is
  unchanged (prepared transactions must point at the pinned current
  escrow — post-cutover, V3). `TRUST-ONCHAIN.md` /
  `known-escrow.json` gain the V3 address as the current pin at
  deploy time (§9), with V2 moving to the superseded section.
- **prepare-lock response** gains `escrowVersion` and
  `expectedGrantId` (§4.3).
- **confirm-lock response** returns the recorded `grantId` (resolved
  from the lock transaction's `Locked` event), and confirm-lock
  accepts an optional `grantId` in the request as a cross-check
  against the event — a mismatch is a hard error, not a silent
  re-key.
- **MCP tools** (`src/lib/mcpTools.ts`): `vesting_status` returns the
  superset shape (§4.5) — its description gains one sentence: a repo
  may carry multiple grants; the top-level grant is the primary and
  `grants` lists all. `wallet_locks` / grant-list tools key rows by
  grantId when present. `prepare_lock`'s description drops any
  one-lock-per-repo wording and documents the two new response
  fields. No tool is removed; no tool's required inputs change.

---

## 7. TEST PLAN

Extend the existing suites; add one new stitched suite. Baselines
from the current tree in parentheses.

**Contract-level (new file `tests/v3-multigrant-test.ts`, hardhat
local chain, beside `tests/v2-nocancel-test.ts`):**

- [ ] NO-CANCEL probe on V3: `cancel()` / recipient-exit selectors
      revert; no such function exists (mirrors the V2 probe).
- [ ] Two grants, same repo, same recipient, same token, different
      schedules: independent milestone maths; interleaved releases
      pay each correctly; one completing does not disturb the other.
- [ ] Grant created mid-stream: baseline stamped from
      `knownPushCount`; pre-lock pushes vest nothing.
- [ ] `reportCount` is oracle-only and monotone (a lower total is
      rejected / ignored per implementation; a non-oracle call
      reverts).
- [ ] Cap: the 11th concurrent active grant reverts; after one
      grant completes, a new lock succeeds (cap counts active only).
- [ ] Same recipient, two tokens: independent accounting; escrow
      balance invariant per token.
- [ ] Streaming + pre-funded grants coexisting on one repo.
- [ ] Amount dust: amount not divisible by milestones pays exactly
      `totalLocked` over the grant's life (final sweep).
- [ ] Overshoot clamp: a release called with a repo total far past
      the grant's schedule pays exactly the remainder and completes.

**Backend / stitched suites to extend:**

- `tests/e2e/run-cutover.sh` (12/12) — add: a V2 grant and a V3
  grant on the SAME repo releasing side by side, each from its own
  escrow, across the config repoint. This is Gregory's production
  shape, tested before it is lived.
- `tests/e2e/run-stitched-e2e.sh` (64/64) — registration of a second
  grant no longer 409s when the first is V3 (and still 409s /
  reverts correctly for a second V1/V2 lock); counter not reset by
  the second registration (SET NX behaviour).
- `tests/e2e/run-recount.sh` — recount certifies the repo total with
  two active grants; recount-and-release settles each grant by the
  §2.5 derivation, including a grant whose baseline postdates part
  of the log.
- `tests/e2e/run-swarm-window.sh` (59/59) and `run-swarm.sh` (37/37)
  — regression only: swarm windows, quorum, and fallback are
  per-push and repo-scoped; expected interplay with multi-grant is
  **none**, and these suites passing unchanged is the evidence.
- `tests/e2e/run-rewards.sh` (28/28) — with two grants vesting on
  one counted push, the author reward is paid exactly once.
- `tests/e2e/run-launch-gate.sh` (87/87), `run-fee-lock.sh`
  (118/118), `run-onboard.sh` (21/21), `run-concurrency.sh`,
  `run-mcp-remote.sh` — regression at baseline; fee-lock in
  particular must prove the fee path is untouched.
- New suite `tests/e2e/run-multigrant.sh` (stitched, local chain +
  fake Redis like the others): the full checklist —
  - [ ] two concurrent V3 grants, disjoint schedules (100/1 and
        50/1, same token, same recipient), interleaved counted
        pushes, both settle correctly to completion;
  - [ ] completion isolation: the 50-push grant completes at its
        50th post-baseline push while the 100-push grant is mid-
        schedule and keeps releasing afterwards;
  - [ ] a legacy V2 grant on the same repo releasing beside the V3
        grants (three grants, two escrows, one counter);
  - [ ] second registration does not reset the repo counter;
  - [ ] status endpoint returns the primary grant + full `grants`
        list; `?grantId=` detail and `/api/vesting/grant/:grantId`
        agree with chain state;
  - [ ] prepare-lock's `expectedGrantId` matches the grantId in the
        `Locked` event when no competing lock intervenes;
  - [ ] swarm-counted push (quorum path) settles all active grants
        the same as a fallback-counted push.

---

## 8. AUDIT IMPACT

GitEscrowV3 is a new money-handling contract and joins the audit
scope in full: at build time `AUDIT-SCOPE.md` needs a delta adding
V3 (grantId derivation, baseline stamping, cap accounting, the
`reportCount` oracle surface) beside GitEscrowV2, FeeStreamEscrow,
FeeLockVault, and ShipRewards, with the off-chain changes in §4
(basis branching, counter ownership) added to the backend scope.
The six §6 audit decisions (tier, budget ceiling, timing, v1 add-on,
report visibility, bounty) remain Gregory's and remain open. The two
quote-request emails to Sherlock and Pashov were stopped by Gregory
on 2026-11-26 before anything was sent; they stay stopped — this
design changes nothing about outreach, and no build step sends
anything.

---

## 9. DEPLOY SEQUENCE (build phase)

1. **Deploy GitEscrowV3** on Base from the platform deployer, with
   the same owner and oracle as V2. Record the address in the
   report (§-style entry) and in `known-escrow.json`.
2. **Verify the source at deploy time** — Sourcify full match AND
   Basescan verified, in the same session as the deployment, using
   the byte-compared compiler settings from the build artifacts.
   (This closes, for V3 from day one, the "couldn't independently
   verify the escrow" objection Bankr raised against V2; the
   parallel V2 verification run covers the existing contracts.)
3. **Backend config cutover for NEW locks only**: set
   `GIT_ESCROW_ADDRESS` = V3 and `GIT_ESCROW_V2_ADDRESS` = the V2
   address (new historical entry, §4.6); `GIT_ESCROW_LEGACY_ADDRESS`
   unchanged. Redeploy the backend; confirm `/health` and the
   prepare-lock smoke below. Existing grants are unaffected by
   construction: every release resolves the grant's own recorded
   escrow.
4. **Smoke — two concurrent grants on a test repo** (a platform test
   repo, dust amounts): lock A (10 pushes), push, lock B (4 pushes)
   while A is active, push through both schedules, confirm
   independent settlement, completion isolation, status list shape,
   and one recount certification over the shared counter.
5. **Skill/MCP updates ship** (§6): skill v5.3 with the V3 pin and
   multi-grant behaviour; Gregory reinstalls in Bankr with the same
   install message.
6. **First real case**: Gregory's second POD lock on
   `anondevv69/github-vesting` — 50% of his POD balance, 50 pushes,
   1 per milestone — prepared fresh (live balance re-read at prepare
   time, per the v5.2 freshness rule) and submitted by Bankr under
   the updated skill. It lands as a V3 grant beside his active V2
   100-push grant: the first production multi-grant repo.

Rollback note: because V3 is additive and every grant carries its
own escrow, rollback is a config change (point `GIT_ESCROW_ADDRESS`
back at V2 for new prepares) plus the §4.3 caveat that any V3 grants
created in the window keep releasing from V3 — which the per-grant
resolution handles with no further action.

---

## 10. BUILD PHASES (estimate, in phases not hours)

- **Phase 1 — Contract**: GitEscrowV3 + contract test file (§7),
  including the no-cancel probe and cap/baseline cases.
- **Phase 2 — Backend**: storage keys + helpers, registration
  changes (409 scope, SET NX counter, V3 event parsing, chain-read
  of `startPushCount`), release basis branch + `reportCount`,
  status superset shapes, chain-config historical list. Suites:
  cutover, stitched, recount extensions green.
- **Phase 3 — Surfaces**: LockPage multi-grant section; skill v5.3 +
  MCP description deltas (§6); new `run-multigrant.sh` stitched
  suite green end to end.
- **Phase 4 — Deploy**: §9 steps 1–4 (deploy, verify, cutover,
  test-repo smoke). Audit-scope delta (§8) drafted alongside.
- **Phase 5 — First real lock**: §9 steps 5–6, Gregory's Bankr-run
  POD lock as the production proof.

Phases 1 and 2 are the critical path; 3 parallelises with 2 once
the status shapes in §4.5 are frozen; 4 and 5 are sequential by
nature.
