// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
 *      BACKEND counted total the keeper supplies from the backend's
 *      own counter at lock time — `backendCountAtLock`).
 *   3. The oracle calls releaseFee(repoId, totalVerifiedPushes) on
 *      counted pushes (the backend's post-count release step, same
 *      signer as GitEscrowV2.release). Each tranche vests pro-rata
 *      over the NEXT `pushesPerTranche` counted pushes after its
 *      baseline; the oracle pays the vested delta to the recipient.
 *      A launcher who stops shipping keeps none of this stream: with
 *      no new counted pushes, nothing new vests, ever. There is no
 *      cancel, no recipient withdrawal, and no time-based release.
 *
 * BASELINE INVARIANT (round 3): a tranche can NEVER vest against a
 * push that was counted before the tranche locked, in EITHER counter.
 * The on-chain oracle report can lag the backend counter (a counted
 * push whose fee report is pending retry has not advanced
 * knownPushCount yet); stamping the baseline from the on-chain
 * counter alone would let that already-counted push vest a tranche
 * locked after it. The keeper therefore (a) refuses to lock while a
 * fee report for the grant is pending, and (b) passes the backend's
 * counted total as `backendCountAtLock`; the tranche's effective
 * baseline is the MAX of the two counters.
 *
 * RELEASE COST (round 3): releaseFee is cursor-bounded. Tranches
 * vest in lock order (baselines are non-decreasing and every tranche
 * in a grant shares one pushesPerTranche, so an earlier tranche's
 * vested fraction is always >= a later one's). Each grant keeps a
 * `settledCursor` — the index of its first not-fully-vested tranche —
 * and releaseFee resumes there instead of rescanning settled
 * tranches, so the cost of a release does not grow with the number
 * of tranches already fully paid. One timing consequence, stated
 * plainly: when several tranches are mid-vesting under the same
 * report, a call pays the deltas up to and including the first
 * not-fully-vested tranche and stops there; the remaining tranches'
 * deltas for that same report are paid by the NEXT releaseFee call
 * (the next counted push, or a retry of this report — each call
 * advances at least one more tranche). Every tranche's lifetime
 * total is identical to a full scan; no tranche is ever paid more
 * or less than its vested amount, only, in that shared-baseline
 * case, across two calls instead of one.
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

    struct FeeTranche {
        uint256 amount;
        /// Effective vesting baseline at lock time: max(on-chain
        /// oracle-reported total, backendCountAtLock). Vesting counts
        /// pushes AFTER this — see the baseline invariant above.
        uint256 baselinePushCount;
        /// The backend's counted-push total when the tranche locked,
        /// as supplied by the keeper. Stored for audit: the gap
        /// between this and the on-chain total at lock time is
        /// exactly the pending-report window round 3 closed.
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
     * @param backendCountAtLock The BACKEND's counted-push total for
     *        this repo at lock time, supplied by the keeper from the
     *        backend's own counter. The on-chain report can lag it
     *        (a counted push whose fee report is pending retry). The
     *        tranche's effective baseline is max(expectedBaseline,
     *        backendCountAtLock), so no push counted before the lock
     *        — in either counter — can ever vest this tranche.
     */
    function addFeeTranche(
        bytes32 repoId,
        uint256 amount,
        uint256 expectedBaseline,
        uint256 backendCountAtLock
    ) external nonReentrant {
        FeeGrant storage g = feeGrants[repoId];
        require(g.registered, "FeeStreamEscrow: no fee grant");
        require(msg.sender == g.vault, "FeeStreamEscrow: not the registered vault");
        require(amount > 0, "FeeStreamEscrow: zero amount");
        require(
            expectedBaseline == knownPushCount[repoId],
            "FeeStreamEscrow: stale baseline - tranche baseline must equal the current counted total"
        );

        IERC20(g.token).safeTransferFrom(msg.sender, address(this), amount);

        uint256 effectiveBaseline = backendCountAtLock > expectedBaseline
            ? backendCountAtLock
            : expectedBaseline;
        uint256 idx = _tranches[repoId].length;
        _tranches[repoId].push(
            FeeTranche({
                amount: amount,
                baselinePushCount: effectiveBaseline,
                backendCountAtLock: backendCountAtLock,
                released: 0
            })
        );
        g.totalFeeLocked += amount;

        emit FeeTrancheLocked(repoId, idx, amount, effectiveBaseline, backendCountAtLock);
    }

    /**
     * @notice Oracle release step, called on counted pushes with the
     *         repo's running counted-push total (same value the backend
     *         passes to GitEscrowV2.release). Pays each tranche's newly
     *         vested delta to the recipient. No-op (no revert) when
     *         nothing new has vested, so the backend can call it on
     *         every counted push.
     */
    function releaseFee(bytes32 repoId, uint256 totalVerifiedPushes) external nonReentrant {
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
        // later can have a delta either — or (b) right after paying
        // a delta that leaves its tranche partially vested.
        uint256 payout = 0;
        uint256 n = _tranches[repoId].length;
        uint256 i = g.settledCursor;
        uint256 newCursor = i;
        bool cursorPinned = false;
        while (i < n) {
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

        if (payout == 0) return;

        g.totalFeeReleased += payout;
        IERC20(g.token).safeTransfer(g.recipient, payout);
        emit FeeReleased(repoId, g.recipient, payout, totalVerifiedPushes, g.totalFeeReleased);
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

    /** Amount that WOULD vest if the oracle reported `atPushCount` now. */
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
