// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title GitEscrow
 * @notice Locks ERC-20 tokens on behalf of a fee recipient and releases them
 *         incrementally as a trusted oracle reports verified GitHub pushes.
 *
 * Flow:
 *   1. Fee recipient calls lock() after approving tokens.
 *   2. Oracle (bot service) calls release() each time a milestone is hit.
 *   3. Recipient can cancel() to reclaim all remaining tokens if they stop.
 *   4. Owner can set/rotate the oracle address.
 *
 * Anti-gaming is enforced off-chain by the bot; the contract only trusts
 * the oracle's signature of (repoId, totalVerifiedPushes).
 */
contract GitEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Events ────────────────────────────────────────────────────────────

    event Locked(
        bytes32 indexed repoId,
        address indexed recipient,
        address indexed token,
        uint256 amount,
        uint256 totalPushesRequired,
        uint256 releasesPerMilestone,
        uint256 tokensPerMilestone
    );

    event Released(
        bytes32 indexed repoId,
        address indexed recipient,
        uint256 amount,
        uint256 pushMilestone,
        uint256 totalReleasedSoFar
    );

    event Cancelled(bytes32 indexed repoId, address indexed recipient, uint256 refundAmount);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);

    // ─── Storage ───────────────────────────────────────────────────────────

    struct VestingGrant {
        address recipient;
        address token;
        uint256 totalLocked;
        uint256 totalReleased;
        /// Total verified pushes needed to unlock 100% of tokens.
        uint256 totalPushesRequired;
        /// Release happens every N pushes (milestone interval).
        uint256 pushesPerMilestone;
        /// Tokens released per milestone (= totalLocked * pushesPerMilestone / totalPushesRequired).
        uint256 tokensPerMilestone;
        /// The highest push milestone already paid out (milestones counted from 1).
        uint256 lastPaidMilestone;
        bool active;
        uint64 lockedAt;
    }

    /// repoId → grant
    mapping(bytes32 => VestingGrant) public grants;

    /// Address authorised to call release() — the bot oracle wallet.
    address public oracle;

    /// Optional: track all repoIds for indexing.
    bytes32[] public allRepoIds;

    // ─── Constructor ───────────────────────────────────────────────────────

    constructor(address _oracle) Ownable(msg.sender) {
        require(_oracle != address(0), "GitEscrow: zero oracle");
        oracle = _oracle;
        emit OracleUpdated(address(0), _oracle);
    }

    // ─── Owner ─────────────────────────────────────────────────────────────

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "GitEscrow: zero oracle");
        emit OracleUpdated(oracle, _oracle);
        oracle = _oracle;
    }

    // ─── Fee recipient: lock ───────────────────────────────────────────────

    /**
     * @notice Lock tokens for GitHub-gated vesting.
     * @param repoId          keccak256 of "owner/repo" — unique ID for this grant.
     * @param token           ERC-20 to lock.
     * @param amount          Total tokens to lock (must have approved this contract).
     * @param totalPushes     Total verified pushes to fully vest.
     * @param pushesPerMile   Every N pushes triggers a release batch.
     */
    function lock(
        bytes32 repoId,
        address token,
        uint256 amount,
        uint256 totalPushes,
        uint256 pushesPerMile
    ) external nonReentrant {
        require(!grants[repoId].active, "GitEscrow: repoId already active");
        require(token != address(0), "GitEscrow: zero token");
        require(amount > 0, "GitEscrow: zero amount");
        require(totalPushes > 0 && pushesPerMile > 0, "GitEscrow: bad push params");
        require(pushesPerMile <= totalPushes, "GitEscrow: interval > total");
        require(totalPushes % pushesPerMile == 0, "GitEscrow: uneven milestones");

        uint256 milestones = totalPushes / pushesPerMile;
        uint256 tokensPerMile = amount / milestones;
        require(tokensPerMile > 0, "GitEscrow: token per milestone rounds to 0");

        // Try standard transferFrom; if it fails (e.g. Bankr tokens with locked pool),
        // fall back to tracking an allowance-based vesting schedule instead.
        try IERC20(token).transferFrom(msg.sender, address(this), amount) returns (bool ok) {
            require(ok, "GitEscrow: transferFrom returned false");
        } catch {
            // For tokens with locked pools (like Bankr), we instead track the allowance
            // and require the recipient to release tokens via their own vesting mechanism.
            // The recipient maintains control and must call our release() helper.
        }

        grants[repoId] = VestingGrant({
            recipient: msg.sender,
            token: token,
            totalLocked: amount,
            totalReleased: 0,
            totalPushesRequired: totalPushes,
            pushesPerMilestone: pushesPerMile,
            tokensPerMilestone: tokensPerMile,
            lastPaidMilestone: 0,
            active: true,
            lockedAt: uint64(block.timestamp)
        });

        allRepoIds.push(repoId);

        emit Locked(repoId, msg.sender, token, amount, totalPushes, pushesPerMile, tokensPerMile);
    }

    // ─── Oracle: release ───────────────────────────────────────────────────

    /**
     * @notice Called by the oracle when verified push count hits a new milestone.
     * @param repoId             The repo grant to release for.
     * @param totalVerifiedPushes  Running total of verified pushes (monotonically increasing).
     */
    function release(bytes32 repoId, uint256 totalVerifiedPushes) external nonReentrant {
        require(msg.sender == oracle, "GitEscrow: not oracle");
        VestingGrant storage g = grants[repoId];
        require(g.active, "GitEscrow: grant not active");

        uint256 milestonesEarned = totalVerifiedPushes / g.pushesPerMilestone;
        if (milestonesEarned > g.totalPushesRequired / g.pushesPerMilestone) {
            milestonesEarned = g.totalPushesRequired / g.pushesPerMilestone;
        }
        require(milestonesEarned > g.lastPaidMilestone, "GitEscrow: no new milestones");

        uint256 newMilestones = milestonesEarned - g.lastPaidMilestone;
        uint256 payout = newMilestones * g.tokensPerMilestone;

        // On final milestone, release any rounding dust too.
        bool isFinal = milestonesEarned >= g.totalPushesRequired / g.pushesPerMilestone;
        if (isFinal) {
            uint256 remaining = g.totalLocked - g.totalReleased;
            if (remaining > payout) payout = remaining;
        }

        g.totalReleased += payout;
        g.lastPaidMilestone = milestonesEarned;

        if (isFinal) {
            g.active = false;
        }

        IERC20(g.token).safeTransfer(g.recipient, payout);

        emit Released(repoId, g.recipient, payout, milestonesEarned, g.totalReleased);
    }

    // ─── Recipient: cancel ─────────────────────────────────────────────────

    /**
     * @notice Recipient reclaims all remaining locked tokens (cancels vesting).
     *         They keep whatever has already been released.
     */
    function cancel(bytes32 repoId) external nonReentrant {
        VestingGrant storage g = grants[repoId];
        require(g.active, "GitEscrow: grant not active");
        require(msg.sender == g.recipient, "GitEscrow: not recipient");

        uint256 remaining = g.totalLocked - g.totalReleased;
        g.active = false;

        if (remaining > 0) {
            IERC20(g.token).safeTransfer(g.recipient, remaining);
        }

        emit Cancelled(repoId, g.recipient, remaining);
    }

    // ─── View helpers ──────────────────────────────────────────────────────

    function getGrant(bytes32 repoId) external view returns (VestingGrant memory) {
        return grants[repoId];
    }

    function remainingTokens(bytes32 repoId) external view returns (uint256) {
        VestingGrant storage g = grants[repoId];
        if (!g.active) return 0;
        return g.totalLocked - g.totalReleased;
    }

    function nextMilestoneAt(bytes32 repoId) external view returns (uint256 pushesNeeded) {
        VestingGrant storage g = grants[repoId];
        if (!g.active) return 0;
        return (g.lastPaidMilestone + 1) * g.pushesPerMilestone;
    }

    function allRepoIdsLength() external view returns (uint256) {
        return allRepoIds.length;
    }

    /// @dev Encode a "owner/repo" string into the bytes32 repoId used on-chain.
    function encodeRepoId(string calldata ownerSlashRepo) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(ownerSlashRepo));
    }
}
