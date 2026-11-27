# On-chain trust — GitEscrow (Proof of Dev)

Third-party skill installers should understand what they are approving before locking tokens.

Pinned values live in `known-escrow.json`. Verify on-chain before first use.

---

## GitEscrowV2 contract (Base) — current for all new locks

| Field | Value |
|-------|-------|
| Address | `0x894e36CbCD183BF5ad79Eba7B988529f0FA769c3` |
| Chain | Base mainnet (`chainId` **8453**) |
| Explorer | [basescan.org/address/0x894e…69c3](https://basescan.org/address/0x894e36CbCD183BF5ad79Eba7B988529f0FA769c3) |
| Source | [github.com/anondevv69/github-vesting — `contracts/GitEscrowV2.sol`](https://github.com/anondevv69/github-vesting/blob/main/contracts/GitEscrowV2.sol) |
| Verification | Source **verified** on BaseScan (exact match) |

Read live `owner()` and `oracle()` on Base — verified 2026-11-27, they match:

| Role | Address |
|------|---------|
| Owner | `0x6dfc5fc9fD6E87957AA060c64006cf52b6c034aB` |
| Oracle | `0x6dfc5fc9fD6E87957AA060c64006cf52b6c034aB` |

Owner can call `setOracle(address)` — oracle rotation is a **trust assumption**.

**No recipient cancel.** GitEscrowV2 has **no** `cancel()` and no
recipient exit of any kind — that is a deliberate platform rule (a
cancellable lock proves nothing). A lock made into V2 runs its full
schedule; recovery from a dead GitHub account comes from verifier
redundancy (owner oracle rotation, backup recount), never from the
recipient pulling tokens back early.

**This pin is the address a NEW Base lock must use.** Every
`prepare-lock` / `POST /api/agent/lock` response for Base is built
against this escrow: the approve spender and the lock transaction's
`to` must both equal it (see the escrow identity check in
`references/TX-VALIDATION.md`). If they point anywhere else — stop
and report both addresses, exactly as the validation doc prescribes.

---

## SUPERSEDED Base escrows — legacy grants only, never valid for a new lock

These contracts still hold **old** grants, which keep releasing on
their own schedules. They are **never** the target of a new lock. If
a fresh prepare response points at one of them, that is a mismatch:
stop and report it (see `references/TX-VALIDATION.md`).

| Address | Contract | History |
|---------|----------|---------|
| `0x3625F879C678306E92E2C27F61b9BcD8015E81A7` | GitEscrow (v1) | Production escrow 2026-11-24 → 2026-11-26; replaced by GitEscrowV2 at the production cutover. The four 2026-11-24 pilot grants live here. |
| `0x76dd4C6ea986684CDf822eC0832e142A2D5C8165` | GitEscrow (v1) | Original June-2026 escrow. Its oracle key was lost, which is why it was replaced. Three June-2026 grants live here. |

---

## GitEscrow contract (Robinhood Chain)

| Field | Value |
|-------|-------|
| Address | `0x706038b47ba6d0CC69479bB286d064137B50f6Ae` |
| Chain | Robinhood Chain mainnet (`chainId` **4663**) |
| Explorer | [robinhoodchain.blockscout.com/address/0x706038…](https://robinhoodchain.blockscout.com/address/0x706038b47ba6d0CC69479bB286d064137B50f6Ae) |
| Source | Same [`contracts/GitEscrow.sol`](https://github.com/anondevv69/github-vesting/blob/main/contracts/GitEscrow.sol) as Base |
| Oracle / Owner | `0x252b98b9fA80D3644Ebcea6CceAB6293430e64a0` (verify live on-chain) |

**Legacy v1 Robinhood escrow** `0xe07df659…6116` — deprecated; do not use for new locks.

**Robinhood lock modes:**

- **Escrow `lock()`** — preferred when token supports transfer into GitEscrow (e.g. RHAGENT with balance). Tokens visible in escrow on Blockscout.
- **`lockAllowance()`** — only when API returns `lockFunction: "lockAllowance"` (restricted / streaming tokens). Tokens stay in wallet; disclose allowance risks below.

Always use `chains["4663"].escrowAddress` from `known-escrow.json` for tx validation on chainId **4663**.

---

## Agent-callable selectors only

| Function | Selector | When used |
|----------|----------|-----------|
| `approve(address,uint256)` on ERC-20 | `0x095ea7b3` | Token contract — spender must be escrow |
| `lock(bytes32,address,uint256,uint256,uint256)` | `0xc9c2dca6` | Standard ERC-20 — tokens move into escrow |
| `lockAllowance(bytes32,address,uint256,uint256,uint256)` | `0xf2bc8198` | Streaming / Bankr tokens — tokens stay in wallet |

**Not used in agent lock flow:** `lockWithPermit`, `release`, `cancel`, `setOracle` — agents must **never** submit these.

Minimal escrow ABI (agent path):

```solidity
function lock(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile) external;
function lockAllowance(bytes32 repoId, address token, uint256 amount, uint256 totalPushes, uint256 pushesPerMile) external;
```

---

## Trust model

1. **Escrow custody (standard `lock`)** — tokens leave the wallet and sit in the escrow until released on schedule.
2. **Streaming (`lockAllowance`)** — tokens remain in the wallet; escrow holds an **ERC-20 allowance** and the oracle pulls per milestone via `transferFrom`.
3. **Oracle** — only the oracle address can call `release()`. Push verification is off-chain; the contract trusts the oracle's milestone reports.
4. **Owner** — can rotate oracle; cannot directly steal locked balances, but a malicious oracle could release early if the off-chain verifier fails.
5. **Recipient exit** — **GitEscrowV2 (Base, current): none.** There is no `cancel()`; the recipient cannot reclaim tokens early or stop vesting. Only the legacy v1 escrows (Base superseded, Robinhood) still expose a recipient `cancel()` for their old grants.

---

## Allowance & revocation risks (streaming locks)

For `lockAllowance` / streaming tokens (e.g. Space):

- You **approve** the escrow for the full lock `amount`.
- Until vesting completes, that allowance lets the escrow pull tokens on each milestone.
- **Revoke risk:** if you `approve(escrow, 0)` or lower allowance below remaining obligation, `release()` may fail and vesting stalls.
- **Cancel:** on **GitEscrowV2 (Base) there is no cancel** — the grant runs its full schedule. Only legacy v1 escrows let the recipient call `cancel(repoId)` to end a grant and reclaim the remaining balance.
- Check allowance anytime: ERC-20 `allowance(yourWallet, escrowAddress)`.

Always disclose before streaming lock:

> "This lock uses an ERC-20 allowance. The escrow can pull tokens from your wallet as milestones are hit until the grant completes. On Base (GitEscrowV2) there is no cancel — the schedule runs to completion."

---

## Off-chain services

| Service | URL | Role |
|---------|-----|------|
| Agent API | `https://api.proofofdev.xyz` | Builds tx calldata, tracks pushes |
| Web UI | `https://www.proofofdev.xyz` | Manual create / link flows |
| GitHub App | `bankr-vesting` | Push webhooks for milestone verification |

The API constructs transactions — that is why `references/TX-VALIDATION.md` is mandatory before submit.
