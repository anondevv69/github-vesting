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
 *   1. The launcher (grant recipient) registers a fee grant naming
 *      exactly one FeeLockVault as its fee source.
 *   2. The vault calls addFeeTranche() — the ONLY way funds enter —
 *      which pulls the vault's accrued fee balance and records a
 *      tranche with baseline = the highest counted-push total the
 *      oracle has reported for this repo so far.
 *   3. The oracle calls releaseFee(repoId, totalVerifiedPushes) on
 *      counted pushes (the backend's post-count release step, same
 *      signer as GitEscrowV2.release). Each tranche vests pro-rata
 *      over the NEXT `pushesPerTranche` counted pushes after its
 *      baseline; the oracle pays the vested delta to the recipient.
 *      A launcher who stops shipping keeps none of this stream: with
 *      no new counted pushes, nothing new vests, ever. There is no
 *      cancel, no recipient withdrawal, and no time-based release.
 */
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
        uint256 baselinePushCount
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
        /// Counted-push total at lock time; vesting counts pushes AFTER this.
        uint256 baselinePushCount;
        uint256 released;
    }

    struct FeeGrant {
        address recipient;
        address token;
        address vault;
        uint256 pushesPerTranche;
        uint256 totalFeeLocked;
        uint256 totalFeeReleased;
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
     * @notice Register the fee grant for a repo. Callable once, by the
     *         grant recipient (the launcher's claim wallet) itself.
     */
    function registerFeeGrant(
        bytes32 repoId,
        address token,
        address vault,
        uint256 pushesPerTranche
    ) external {
        require(!feeGrants[repoId].registered, "FeeStreamEscrow: already registered");
        require(token != address(0), "FeeStreamEscrow: zero token");
        require(vault != address(0), "FeeStreamEscrow: zero vault");
        require(pushesPerTranche > 0, "FeeStreamEscrow: zero pushesPerTranche");

        feeGrants[repoId] = FeeGrant({
            recipient: msg.sender,
            token: token,
            vault: vault,
            pushesPerTranche: pushesPerTranche,
            totalFeeLocked: 0,
            totalFeeReleased: 0,
            registered: true
        });

        emit FeeGrantRegistered(repoId, msg.sender, token, vault, pushesPerTranche);
    }

    /**
     * @notice Lock one accrued-fee tranche. ONLY the grant's registered
     *         vault may call this; funds are pulled from the vault.
     * @param expectedBaseline The counted-push total the caller read
     *        from this escrow immediately before locking. The tranche
     *        is stamped with THIS escrow's authoritative counted
     *        total — `knownPushCount`, the same counter releaseFee
     *        vests against (advanced only by oracle reports) — and
     *        the call REVERTS when expectedBaseline differs from it.
     *        A tranche locked against a stale read (a push counted in
     *        between) must retry with the fresh total, never vest
     *        against pushes that predate the lock.
     */
    function addFeeTranche(bytes32 repoId, uint256 amount, uint256 expectedBaseline) external nonReentrant {
        FeeGrant storage g = feeGrants[repoId];
        require(g.registered, "FeeStreamEscrow: no fee grant");
        require(msg.sender == g.vault, "FeeStreamEscrow: not the registered vault");
        require(amount > 0, "FeeStreamEscrow: zero amount");
        require(
            expectedBaseline == knownPushCount[repoId],
            "FeeStreamEscrow: stale baseline - tranche baseline must equal the current counted total"
        );

        IERC20(g.token).safeTransferFrom(msg.sender, address(this), amount);

        uint256 idx = _tranches[repoId].length;
        _tranches[repoId].push(
            FeeTranche({ amount: amount, baselinePushCount: knownPushCount[repoId], released: 0 })
        );
        g.totalFeeLocked += amount;

        emit FeeTrancheLocked(repoId, idx, amount, knownPushCount[repoId]);
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

        uint256 payout = 0;
        uint256 n = _tranches[repoId].length;
        for (uint256 i = 0; i < n; i++) {
            FeeTranche storage t = _tranches[repoId][i];
            uint256 vested = _vested(t, g.pushesPerTranche, totalVerifiedPushes);
            if (vested > t.released) {
                payout += vested - t.released;
                t.released = vested;
            }
        }

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
        returns (uint256 amount, uint256 baselinePushCount, uint256 released)
    {
        FeeTranche storage t = _tranches[repoId][index];
        return (t.amount, t.baselinePushCount, t.released);
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
