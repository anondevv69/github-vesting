// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
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
        /// If true, tokens are pulled from recipient's wallet per milestone
        /// (streaming-allowance model). If false, tokens were pre-funded.
        bool streaming;
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

// Try to pull tokens upfront. For normal ERC-20s this works.
// For Bankr DERC20 tokens (or any token with a locked-pool guard
// around the receiver), this reverts. In that case the recipient
// should call lockAllowance() instead so we record the grant
// without taking custody of the tokens.
        try this._tryPull(token, msg.sender, amount) {
            // tokens are now in escrow
        } catch {
            revert("GitEscrow: pull failed - use lockAllowance for restricted tokens");
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
            streaming: false,
            lockedAt: uint64(block.timestamp)
        });

        allRepoIds.push(repoId);

        emit Locked(repoId, msg.sender, token, amount, totalPushes, pushesPerMile, tokensPerMile);
    }

    /// @dev External helper so we can use try/catch around the token call.
    function _tryPull(address token, address from, uint256 amount) external {
        require(msg.sender == address(this), "GitEscrow: internal");
        IERC20(token).safeTransferFrom(from, address(this), amount);
    }

    /**
     * @notice Streaming-approval lock for tokens with restricted transferFrom
     *         (e.g. Bankr DERC20 tokens with a locked pool that prevents the
     *         escrow contract from receiving tokens).
     *
     *         The recipient must `approve` this contract for `amount` tokens
     *         BEFORE calling. The contract pulls tokens per milestone as
     *         releases happen, so the recipient's wallet retains custody
     *         until each payout.
     *
     *         Compatible with all ERC-20s (including ones with locked pools),
     *         because it only requires the standard `approve` + `transferFrom`
     *         to succeed at release time, not at lock time.
     */
    function lockAllowance(
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

        // Verify the recipient has approved us for at least `amount`.
        require(
            IERC20(token).allowance(msg.sender, address(this)) >= amount,
            "GitEscrow: insufficient allowance"
        );

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
            streaming: true,
            lockedAt: uint64(block.timestamp)
        });

        allRepoIds.push(repoId);

        emit Locked(repoId, msg.sender, token, amount, totalPushes, pushesPerMile, tokensPerMile);
    }

    /**
     * @notice Lock with EIP-2612 permit signature (single-transaction flow).
     *         The user signs a permit off-chain, the contract calls
     *         IERC20Permit.permit() to set the allowance, then records
     *         the grant in streaming mode.
     *
     *         This is required for tokens that block `approve()` calls
     *         (e.g. Bankr DERC20 / Space) but do implement EIP-2612.
     */
    function lockWithPermit(
        bytes32 repoId,
        address token,
        uint256 amount,
        uint256 totalPushes,
        uint256 pushesPerMile,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
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

        // Set the allowance via EIP-2612 permit in the same transaction.
        // This sidesteps any token-side `approve` restrictions.
        IERC20Permit(token).permit(msg.sender, address(this), amount, deadline, v, r, s);

        // Verify the allowance was actually set.
        require(
            IERC20(token).allowance(msg.sender, address(this)) >= amount,
            "GitEscrow: permit did not set allowance"
        );

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
            streaming: true,
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

        // Streaming-allowance: pull tokens from recipient to the oracle, then
// the oracle forwards them to the recipient via a regular `transfer`.
// We use the oracle (msg.sender) as the intermediate to avoid sending
// tokens directly into the escrow contract, which is essential for
// Bankr DERC20 tokens that block transfers to the pool (escrow) address.
// The recipient must keep an allowance >= remaining balance for this
// to succeed at each milestone.
// Pre-funded: tokens are already in escrow, just send them out.
        if (g.streaming) {
            IERC20(g.token).safeTransferFrom(g.recipient, msg.sender, payout);
            require(
                IERC20(g.token).balanceOf(msg.sender) >= payout,
                "GitEscrow: oracle did not receive"
            );
            // The oracle EOA must then send the tokens to the recipient
            // off-chain. The oracle bot handles this step after each
            // release() call.
        } else {
            IERC20(g.token).safeTransfer(g.recipient, payout);
        }

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
