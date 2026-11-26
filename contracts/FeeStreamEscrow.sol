// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title FeeStreamEscrow
 * @notice Companion escrow for LAUNCHER TRADING FEES (Gregory's decided
 *         fee-lock rule, 2026-11-25): a launcher's fee share must NOT
 *         arrive liquid — it is auto-locked here and unlocks only by
 *         counted pushes, through the same oracle as supply releases.
 *
 * Why a companion contract instead of extending GitEscrowV2: supply
 * grants have one fixed amount and one schedule fixed at lock time;
 * fee tranches arrive over time and each carries its OWN baseline
 * (the counted-push total at the moment it locked). GitEscrowV2 stays
 * byte-identical in behavior; this contract holds only fee streams.
 *
 * Flow:
 *   1. The platform REGISTRAR (this contract's owner, set at deploy)
 *      registers a fee grant naming the recipient, the fee token,
 *      and exactly one FeeLockVault as its fee source. Registration
 *      validates the vault's immutable bindings on-chain (escrow ==
 *      this contract, launcher == recipient, repoId, feeToken ==
 *      token). First-caller-wins registration was removed in round 3:
 *      an arbitrary first caller must never be able to make itself
 *      the recipient of a repo's fee stream.
 *   2. The vault calls addFeeTranche() — the ONLY way funds enter —
 *      which pulls the vault's accrued fee balance and records a
 *      tranche whose vesting baseline is max(the highest counted-push
 *      total the oracle has reported for this repo so far, the
 *      ORACLE-ATTESTED backend counted total — see the baseline
 *      invariant below).
 *   3. The oracle calls releaseFee(repoId, totalVerifiedPushes) on
 *      counted pushes (the backend's post-count release step, same
 *      signer as GitEscrowV2.release). Each tranche vests pro-rata
 *      over the NEXT `pushesPerTranche` counted pushes after its
 *      baseline; the oracle pays the vested delta to the recipient.
 *      A launcher who stops shipping keeps none of this stream: with
 *      no new counted pushes, nothing new vests, ever. There is no
 *      cancel, no recipient withdrawal, and no time-based release.
 *
 * BASELINE INVARIANT (rounds 3+4): a tranche can NEVER vest against
 * a push that was counted before the tranche locked, in EITHER
 * counter. The on-chain oracle report can lag the backend counter
 * (a counted push whose fee report is pending retry has not
 * advanced knownPushCount yet); stamping the baseline from the
 * on-chain counter alone would let that already-counted push vest a
 * tranche locked after it.
 *
 * Round 3 stamped the baseline from a keeper-supplied backend count
 * (`backendCountAtLock`). Round 4 (Codex) pointed out that number
 * was UNAUTHENTICATED: anyone can call the vault's lockAccrued, and
 * this contract could not verify a caller-supplied count — a forged
 * LOW count credits pre-lock work, a forged HIGH count strands the
 * tranche. The bare-count path is DELETED. The baseline's backend
 * component is now an EIP-712 CountAttestation signed by THIS
 * CONTRACT'S ORACLE (the same signer trusted for release counts),
 * binding (escrow, repoId, vault, countedTotal, issuedAt, expiry,
 * nonce). addFeeTranche verifies the signature and the bindings,
 * rejects expired attestations, enforces a per-repo MONOTONE nonce
 * and a MONOTONE attested total (a stale attestation can never
 * lower a later tranche's floor, and a consumed nonce can never be
 * replayed). The tranche's effective baseline is max(knownPushCount,
 * attestedTotal). The keeper's Redis pending-report check remains
 * as a courtesy layer; it is no longer load-bearing.
 *
 * Residue, stated precisely: an attestation is a signed statement
 * of the backend's count at issuance, valid for a short window
 * (the backend issues expiry = issuedAt + 300s). A tranche locked
 * inside that window with a just-issued attestation carries the
 * count as of issuance; a push that counts in the backend AFTER
 * issuance but before the lock lands is not in the attested total.
 * The platform keeper fetches its attestation immediately before
 * locking and defers while a report is pending, so this window is
 * not exercised by the platform flow; the monotone floors bound
 * any third-party caller's attestation to one the oracle actually
 * signed within its validity window.
 *
 * RELEASE COST (rounds 3+4): releaseFee is cursor-bounded AND
 * work-capped. Tranches vest in lock order (baselines are
 * non-decreasing and every tranche in a grant shares one
 * pushesPerTranche, so an earlier tranche's vested fraction is
 * always >= a later one's). Each grant keeps a `settledCursor` —
 * the index of its first not-fully-vested tranche — and releaseFee
 * resumes there instead of rescanning settled tranches, so the
 * cost of a release does not grow with the number of tranches
 * already fully paid. Round 4 adds a hard per-call work cap
 * (MAX_TRANCHES_PER_RELEASE): one call processes at most that many
 * tranches, so a single transaction's gas is bounded no matter how
 * many tranches vest at the same count. A call may therefore leave
 * vested fees unpaid; settlement is NOT inferred from a successful
 * transaction — the backend reads releasableAt(repoId, count)
 * after the receipt and keeps the release queued (durable pending
 * entry, drained by the fee-release sweep with no new pushes
 * required) until it reports zero. One timing consequence, stated
 * plainly: when several tranches are mid-vesting under the same
 * report, a call pays the deltas up to and including the first
 * not-fully-vested tranche and stops there; the remaining tranches'
 * deltas for that same report are paid by the NEXT releaseFee call
 * (the next counted push, a retry of this report, or the sweep —
 * each call advances at least one more tranche). Every tranche's
 * lifetime total is identical to a full scan; no tranche is ever
 * paid more or less than its vested amount, only, in that
 * shared-baseline case, across more than one call.
 */
/// @notice The immutable-binding getters every approved FeeLockVault
///         exposes; registration reads them to prove the named vault
///         really is bound to this escrow, this repo, this recipient.
interface IFeeLockVaultView {
    function escrow() external view returns (address);
    function feeToken() external view returns (address);
    function repoId() external view returns (bytes32);
    function launcher() external view returns (address);
}

contract FeeStreamEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    event FeeGrantRegistered(
        bytes32 indexed repoId,
        address indexed recipient,
        address indexed token,
        address vault,
        uint256 pushesPerTranche
    );

    event FeeTrancheLocked(
        bytes32 indexed repoId,
        uint256 indexed trancheIndex,
        uint256 amount,
        uint256 baselinePushCount,
        uint256 backendCountAtLock
    );

    event FeeReleased(
        bytes32 indexed repoId,
        address indexed recipient,
        uint256 amount,
        uint256 totalVerifiedPushes,
        uint256 totalFeeReleasedSoFar
    );

    event OracleUpdated(address indexed oldOracle, address indexed newOracle);

    /**
     * @notice Oracle-signed statement of the backend's counted-push
     *         total for one repo, bound to one vault (Codex round-4,
     *         blocker 1). Issued by the backend (src/lib/
     *         countAttestation.ts) at keeper lock time, signed by
     *         this contract's oracle key. The EIP-712 domain is
     *         ("ProofOfDev FeeStreamEscrow", "1", chainId, this
     *         contract) — the escrow binding is therefore both a
     *         struct field and the domain's verifyingContract.
     */
    struct CountAttestation {
        address escrow;
        bytes32 repoId;
        address vault;
        uint256 countedTotal;
        uint256 issuedAt;
        uint256 expiry;
        uint256 nonce;
    }

    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256(
            "CountAttestation(address escrow,bytes32 repoId,address vault,uint256 countedTotal,uint256 issuedAt,uint256 expiry,uint256 nonce)"
        );
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /**
     * @notice Hard cap on tranches processed per releaseFee call
     *         (Codex round-4, blocker 2). Gas math (measured in
     *         tests/fee-cursor-test.ts on the local chain): a paying
     *         releaseFee call carries ~117k fixed overhead (base tx,
     *         oracle/grant loads, cursor + counter writes, one
     *         aggregated transfer) plus ~28k marginal per tranche
     *         processed (tranche storage reads + the released-amount
     *         write): a 2-tranche call measured 173,582 and a
     *         16-tranche call 570,393. The cap therefore bounds ANY
     *         single release at ~570k gas no matter how large the
     *         vested backlog grows — an uncapped call over the same
     *         test's 40-tranche backlog would cost ~1.25M, and over
     *         a years-long stream's backlog, linearly more, until
     *         the release became impractical to execute at all.
     *         Callers drain any remainder with repeat calls (the
     *         backend sweep does exactly this, no new pushes
     *         required).
     */
    uint256 public constant MAX_TRANCHES_PER_RELEASE = 16;

    struct FeeTranche {
        uint256 amount;
        /// Effective vesting baseline at lock time: max(on-chain
        /// oracle-reported total, backendCountAtLock). Vesting counts
        /// pushes AFTER this — see the baseline invariant above.
        uint256 baselinePushCount;
        /// The ORACLE-ATTESTED backend counted-push total the
        /// tranche locked under (round 4: previously a bare
        /// keeper-supplied value — the field name is kept for the
        /// existing audit getters; the value is now verified
        /// on-chain against the oracle's EIP-712 signature before
        /// it is stored). The gap between this and the on-chain
        /// total at lock time is exactly the pending-report window.
        uint256 backendCountAtLock;
        uint256 released;
    }

    struct FeeGrant {
        address recipient;
        address token;
        address vault;
        uint256 pushesPerTranche;
        uint256 totalFeeLocked;
        uint256 totalFeeReleased;
        /// Index of the first not-fully-vested tranche; releaseFee
        /// resumes here and never rescans settled tranches.
        uint256 settledCursor;
        bool registered;
    }

    mapping(bytes32 => FeeGrant) public feeGrants;
    mapping(bytes32 => FeeTranche[]) private _tranches;
    /// Highest counted-push total the oracle has reported per repo —
    /// the baseline source for new tranches. Monotonic.
    mapping(bytes32 => uint256) public knownPushCount;
    /// Highest attested backend counted total accepted per repo —
    /// a new tranche's attestation must be >= this (monotone floor:
    /// a stale attestation can never lower a later tranche's
    /// baseline below one already accepted).
    mapping(bytes32 => uint256) public lastAttestedTotal;
    /// Highest attestation nonce accepted per repo — a new
    /// attestation's nonce must be strictly greater (a consumed
    /// attestation can never be replayed, and any attestation
    /// issued before the latest consumed one is dead on arrival).
    mapping(bytes32 => uint256) public lastAttestationNonce;

    address public oracle;

    constructor(address _oracle) Ownable(msg.sender) {
        require(_oracle != address(0), "FeeStreamEscrow: zero oracle");
        oracle = _oracle;
        emit OracleUpdated(address(0), _oracle);
    }

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "FeeStreamEscrow: zero oracle");
        emit OracleUpdated(oracle, _oracle);
        oracle = _oracle;
    }

    /**
     * @notice Register the fee grant for a repo. REGISTRAR ONLY (the
     *         contract owner, set at deploy — the same key pattern
     *         the backend uses for its other privileged calls).
     *         Callable once per repo. The named vault's immutable
     *         bindings are verified on-chain: its escrow must be
     *         THIS contract, its launcher must be the recipient, its
     *         repoId must be this repo, and its fee token must be
     *         the grant token. A vault bound anywhere else, or an
     *         address without the vault getters, reverts.
     */
    function registerFeeGrant(
        bytes32 repoId,
        address recipient,
        address token,
        address vault,
        uint256 pushesPerTranche
    ) external onlyOwner {
        require(!feeGrants[repoId].registered, "FeeStreamEscrow: already registered");
        require(recipient != address(0), "FeeStreamEscrow: zero recipient");
        require(token != address(0), "FeeStreamEscrow: zero token");
        require(vault != address(0), "FeeStreamEscrow: zero vault");
        require(pushesPerTranche > 0, "FeeStreamEscrow: zero pushesPerTranche");

        IFeeLockVaultView v = IFeeLockVaultView(vault);
        require(v.escrow() == address(this), "FeeStreamEscrow: vault bound to a different escrow");
        require(v.launcher() == recipient, "FeeStreamEscrow: vault launcher is not the recipient");
        require(v.repoId() == repoId, "FeeStreamEscrow: vault bound to a different repo");
        require(v.feeToken() == token, "FeeStreamEscrow: vault fee token mismatch");

        feeGrants[repoId] = FeeGrant({
            recipient: recipient,
            token: token,
            vault: vault,
            pushesPerTranche: pushesPerTranche,
            totalFeeLocked: 0,
            totalFeeReleased: 0,
            settledCursor: 0,
            registered: true
        });

        emit FeeGrantRegistered(repoId, recipient, token, vault, pushesPerTranche);
    }

    /// EIP-712 domain separator for CountAttestation, computed per
    /// call so a chain fork can never strand signatures.
    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("ProofOfDev FeeStreamEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /**
     * @notice Verify a CountAttestation against this contract's
     *         oracle and consume it (monotone nonce + total floors).
     *         Every failure reverts — there is no unauthenticated
     *         path to a backend-count baseline (round 4).
     */
    function _verifyAndConsumeAttestation(
        bytes32 repoId,
        address vault,
        CountAttestation calldata att,
        bytes calldata signature
    ) internal returns (uint256 attestedTotal) {
        require(att.escrow == address(this), "FeeStreamEscrow: attestation bound to a different escrow");
        require(att.repoId == repoId, "FeeStreamEscrow: attestation bound to a different repo");
        require(att.vault == vault, "FeeStreamEscrow: attestation bound to a different vault");
        require(att.issuedAt <= block.timestamp, "FeeStreamEscrow: attestation not yet valid");
        require(block.timestamp <= att.expiry, "FeeStreamEscrow: attestation expired");
        require(
            att.nonce > lastAttestationNonce[repoId],
            "FeeStreamEscrow: attestation nonce already consumed"
        );
        require(
            att.countedTotal >= lastAttestedTotal[repoId],
            "FeeStreamEscrow: attested total below the accepted floor"
        );
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                att.escrow,
                att.repoId,
                att.vault,
                att.countedTotal,
                att.issuedAt,
                att.expiry,
                att.nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        require(
            ECDSA.recover(digest, signature) == oracle,
            "FeeStreamEscrow: attestation signer is not the oracle"
        );
        lastAttestationNonce[repoId] = att.nonce;
        lastAttestedTotal[repoId] = att.countedTotal;
        return att.countedTotal;
    }

    /**
     * @notice Lock one accrued-fee tranche. ONLY the grant's registered
     *         vault may call this; funds are pulled from the vault.
     * @param expectedBaseline The counted-push total the caller read
     *        from this escrow immediately before locking. The call
     *        REVERTS when it differs from this escrow's authoritative
     *        on-chain total — `knownPushCount`, the same counter
     *        releaseFee vests against (advanced only by oracle
     *        reports). A tranche locked against a stale read (a push
     *        counted in between) must retry with the fresh total.
     * @param att The oracle-signed CountAttestation of the BACKEND's
     *        counted-push total for this repo at lock time (round 4:
     *        the bare caller-supplied count of round 3 is gone — the
     *        escrow verifies the oracle's signature itself). The
     *        on-chain report can lag the attested total (a counted
     *        push whose fee report is pending retry). The tranche's
     *        effective baseline is max(expectedBaseline,
     *        att.countedTotal), so no push counted before the lock
     *        — in either counter — can ever vest this tranche.
     */
    function addFeeTranche(
        bytes32 repoId,
        uint256 amount,
        uint256 expectedBaseline,
        CountAttestation calldata att,
        bytes calldata signature
    ) external nonReentrant {
        FeeGrant storage g = feeGrants[repoId];
        require(g.registered, "FeeStreamEscrow: no fee grant");
        require(msg.sender == g.vault, "FeeStreamEscrow: not the registered vault");
        require(amount > 0, "FeeStreamEscrow: zero amount");
        require(
            expectedBaseline == knownPushCount[repoId],
            "FeeStreamEscrow: stale baseline - tranche baseline must equal the current counted total"
        );
        uint256 attestedTotal = _verifyAndConsumeAttestation(repoId, msg.sender, att, signature);

        IERC20(g.token).safeTransferFrom(msg.sender, address(this), amount);

        uint256 effectiveBaseline = attestedTotal > expectedBaseline
            ? attestedTotal
            : expectedBaseline;
        uint256 idx = _tranches[repoId].length;
        _tranches[repoId].push(
            FeeTranche({
                amount: amount,
                baselinePushCount: effectiveBaseline,
                backendCountAtLock: attestedTotal,
                released: 0
            })
        );
        g.totalFeeLocked += amount;

        emit FeeTrancheLocked(repoId, idx, amount, effectiveBaseline, attestedTotal);
    }

    /**
     * @notice Oracle release step, called on counted pushes with the
     *         repo's running counted-push total (same value the backend
     *         passes to GitEscrowV2.release). Pays each tranche's newly
     *         vested delta to the recipient. No-op (no revert) when
     *         nothing new has vested, so the backend can call it on
     *         every counted push.
     * @return paidNow The amount this call actually paid. A call is
     *         work-capped (MAX_TRANCHES_PER_RELEASE) and may leave
     *         vested fees unpaid — settlement at a count is decided
     *         by releasableAt(repoId, totalVerifiedPushes) == 0,
     *         never by this call succeeding (round 4).
     */
    function releaseFee(bytes32 repoId, uint256 totalVerifiedPushes) external nonReentrant returns (uint256 paidNow) {
        require(msg.sender == oracle, "FeeStreamEscrow: not oracle");
        FeeGrant storage g = feeGrants[repoId];
        require(g.registered, "FeeStreamEscrow: no fee grant");

        if (totalVerifiedPushes > knownPushCount[repoId]) {
            knownPushCount[repoId] = totalVerifiedPushes;
        }

        // Cursor-bounded scan (round 3): resume at the first
        // not-fully-vested tranche; never rescan settled history.
        // The stored cursor ALWAYS remains the index of the first
        // not-fully-vested tranche (it is pinned the moment the scan
        // meets one), even when the scan continues past it: a
        // tranche that is partial but has NO new delta at this
        // total (an earlier call already paid it up to this report)
        // is skipped so a repeat call at the same total drains the
        // next tranche's backlog delta instead of stalling — but the
        // cursor never jumps over it, so its remaining vesting is
        // picked up by the next call. The scan stops (a) at the
        // first tranche whose baseline this report has not reached
        // — baselines are non-decreasing in lock order, so nothing
        // later can have a delta either — (b) right after paying
        // a delta that leaves its tranche partially vested, or
        // (c) after processing MAX_TRANCHES_PER_RELEASE tranches
        // (round 4 work cap: one transaction's gas is bounded no
        // matter how large the vested backlog is; the remainder
        // stays due and is drained by repeat calls).
        uint256 payout = 0;
        uint256 n = _tranches[repoId].length;
        uint256 i = g.settledCursor;
        uint256 newCursor = i;
        bool cursorPinned = false;
        uint256 processed = 0;
        while (i < n && processed < MAX_TRANCHES_PER_RELEASE) {
            processed++;
            FeeTranche storage t = _tranches[repoId][i];
            if (totalVerifiedPushes <= t.baselinePushCount) {
                if (!cursorPinned) {
                    newCursor = i;
                    cursorPinned = true;
                }
                break;
            }
            uint256 vested = _vested(t, g.pushesPerTranche, totalVerifiedPushes);
            bool paidDelta = vested > t.released;
            if (paidDelta) {
                payout += vested - t.released;
                t.released = vested;
            }
            if (t.released == t.amount) {
                if (!cursorPinned) newCursor = i + 1;
                i++;
                continue;
            }
            // Partially vested: pin the cursor here.
            if (!cursorPinned) {
                newCursor = i;
                cursorPinned = true;
            }
            if (paidDelta) break;
            i++;
        }
        if (!cursorPinned) newCursor = i;
        g.settledCursor = newCursor;

        if (payout == 0) return 0;

        g.totalFeeReleased += payout;
        IERC20(g.token).safeTransfer(g.recipient, payout);
        emit FeeReleased(repoId, g.recipient, payout, totalVerifiedPushes, g.totalFeeReleased);
        return payout;
    }

    function _vested(
        FeeTranche storage t,
        uint256 pushesPerTranche,
        uint256 totalVerifiedPushes
    ) internal view returns (uint256) {
        if (totalVerifiedPushes <= t.baselinePushCount) return t.released;
        uint256 elapsed = totalVerifiedPushes - t.baselinePushCount;
        if (elapsed >= pushesPerTranche) return t.amount;
        return (t.amount * elapsed) / pushesPerTranche;
    }

    // ─── Views ─────────────────────────────────────────────────────────

    function trancheCount(bytes32 repoId) external view returns (uint256) {
        return _tranches[repoId].length;
    }

    function getTranche(bytes32 repoId, uint256 index)
        external
        view
        returns (
            uint256 amount,
            uint256 baselinePushCount,
            uint256 released,
            uint256 backendCountAtLock
        )
    {
        FeeTranche storage t = _tranches[repoId][index];
        return (t.amount, t.baselinePushCount, t.released, t.backendCountAtLock);
    }

    /** Index of the grant's first not-fully-vested tranche. */
    function settledCursor(bytes32 repoId) external view returns (uint256) {
        return feeGrants[repoId].settledCursor;
    }

    /**
     * Amount vested-and-unpaid if the oracle reported `atPushCount`
     * now — the SETTLEMENT read (round 4): because releaseFee is
     * work-capped, a successful release transaction does NOT imply
     * everything due at a count was paid. The backend reads this
     * after every release receipt and keeps the release queued
     * until it returns 0 at the target count. (A full scan is fine
     * here: it is an eth_call, not a transaction.)
     */
    function releasableAt(bytes32 repoId, uint256 atPushCount) external view returns (uint256) {
        FeeGrant storage g = feeGrants[repoId];
        if (!g.registered) return 0;
        uint256 total = 0;
        uint256 n = _tranches[repoId].length;
        for (uint256 i = 0; i < n; i++) {
            FeeTranche storage t = _tranches[repoId][i];
            uint256 v = _vested(t, g.pushesPerTranche, atPushCount);
            if (v > t.released) total += v - t.released;
        }
        return total;
    }
}
