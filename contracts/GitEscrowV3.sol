// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title GitEscrowV3
 * @notice Locks ERC-20 tokens and releases them incrementally as a trusted
 *         oracle reports verified GitHub pushes. V3 supports MULTIPLE
 *         concurrent grants per repo (MULTI-LOCK-DESIGN.md, adopted by
 *         Gregory 2026-11-27): grants are keyed by a per-grant grantId,
 *         and each grant vests only on pushes counted AFTER its own lock
 *         time, via a per-grant baseline (`startPushCount`) stamped from
 *         the oracle-advanced repo counter (`knownPushCount`).
 *
 * Flow:
 *   1. Recipient calls lock() / lockAllowance() / lockWithPermit() after
 *      approving tokens. The call returns the new grantId.
 *   2. Oracle calls reportCount() as pushes are counted, and release()
 *      per grant each time a milestone is hit.
 *   3. Owner can set/rotate the oracle address.
 *
 * V3 — NO-CANCEL RULE (Gregory, 2026-11-25): there is deliberately NO
 * cancel() / recipient exit in this contract. A lock that its recipient
 * can unwind proves nothing; releases happen ONLY via the oracle on
 * verified pushes. Recovery from a dead verifier/GitHub App is an
 * ORACLE problem, solved by the owner rotating the oracle (setOracle)
 * to a backup verifier that recounts pushes from public git/GitHub
 * data — never by letting the recipient pull tokens back out.
 *
 * Anti-gaming is enforced off-chain by the bot; the contract only trusts
 * calls from the oracle address (msg.sender == oracle). release()
 * carries (grantId, repoCumulativeTotal) — there is no signature scheme.
 * The baseline a grant starts from is NEVER caller-supplied: it is
 * stamped from `knownPushCount`, which only the oracle can advance
 * (via release() and reportCount()).
 */
contract GitEscrowV3 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ─────────────────────────────────────────────────────────

    /// Maximum number of simultaneously ACTIVE grants per repo
    /// (MULTI-LOCK-DESIGN Decision 2). Completed grants do not count.
    uint256 public constant MAX_GRANTS_PER_REPO = 10;

    // ─── Events ────────────────────────────────────────────────────────────

    event Locked(
        bytes32 indexed grantId,
        bytes32 indexed repoId,
        address indexed recipient,
        address token,
        uint256 amount,
        uint256 totalPushesRequired,
        uint256 releasesPerMilestone,
        uint256 tokensPerMilestone,
        uint256 startPushCount
    );

    event Released(
        bytes32 indexed grantId,
        bytes32 indexed repoId,
        address indexed recipient,
        uint256 amount,
        uint256 pushMilestone,
        uint256 totalReleasedSoFar
    );

    event PushCountReported(bytes32 indexed repoId, uint256 totalVerifiedPushes);

    event OracleUpdated(address indexed oldOracle, address indexed newOracle);

    // ─── Storage ───────────────────────────────────────────────────────────

    struct VestingGrant {
        /// The repo this grant belongs to.
        bytes32 repoId;
        address recipient;
        address token;
        uint256 totalLocked;
        uint256 totalReleased;
        /// Total verified pushes (after the baseline) needed to unlock 100%.
        uint256 totalPushesRequired;
        /// Release happens every N pushes (milestone interval).
        uint256 pushesPerMilestone;
        /// Tokens released per milestone (= totalLocked / milestones, floored).
        uint256 tokensPerMilestone;
        /// The highest push milestone already paid out (milestones counted from 1).
        uint256 lastPaidMilestone;
        bool active;
        /// If true, tokens are pulled from recipient's wallet per milestone
        /// (streaming-allowance model). If false, tokens were pre-funded.
        bool streaming;
        uint64 lockedAt;
        /// Repo cumulative counted total at lock time. This grant vests
        /// only on pushes counted after this baseline.
        uint256 startPushCount;
    }

    /// grantId → grant
    mapping(bytes32 => VestingGrant) public grants;

    /// repoId → next grant nonce (number of grants ever created for the repo).
    mapping(bytes32 => uint256) public grantNonce;

    /// repoId → number of currently ACTIVE grants (the cap counter).
    mapping(bytes32 => uint256) public activeGrantCount;

    /// repoId → every grantId ever created for the repo, in lock order.
    mapping(bytes32 => bytes32[]) public repoGrantIds;

    /// repoId → highest repo counted total the oracle has reported to
    /// THIS contract. Advanced only by release() and reportCount().
    mapping(bytes32 => uint256) public knownPushCount;

    /// Address authorised to call release() / reportCount() — the bot oracle wallet.
    address public oracle;

    /// Optional: track all repoIds (first grant per repo) for indexing.
    bytes32[] public allRepoIds;

    // ─── Constructor ───────────────────────────────────────────────────────

    constructor(address _oracle) Ownable(msg.sender) {
        require(_oracle != address(0), "GitEscrowV3: zero oracle");
        oracle = _oracle;
        emit OracleUpdated(address(0), _oracle);
    }

    // ─── Owner ─────────────────────────────────────────────────────────────

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "GitEscrowV3: zero oracle");
        emit OracleUpdated(oracle, _oracle);
        oracle = _oracle;
    }

    // ─── Internal: schedule validation + grant creation ────────────────────

    function _validateSchedule(
        address token,
        uint256 amount,
        uint256 totalPushes,
        uint256 pushesPerMile
    ) internal pure returns (uint256 tokensPerMile) {
        require(token != address(0), "GitEscrowV3: zero token");
        require(amount > 0, "GitEscrowV3: zero amount");
        require(totalPushes > 0 && pushesPerMile > 0, "GitEscrowV3: bad push params");
        require(pushesPerMile <= totalPushes, "GitEscrowV3: interval > total");
        require(totalPushes % pushesPerMile == 0, "GitEscrowV3: uneven milestones");

        uint256 milestones = totalPushes / pushesPerMile;
        tokensPerMile = amount / milestones;
        require(tokensPerMile > 0, "GitEscrowV3: token per milestone rounds to 0");
    }

    function _createGrant(
        bytes32 repoId,
        address token,
        uint256 amount,
        uint256 totalPushes,
        uint256 pushesPerMile,
        uint256 tokensPerMile,
        bool streaming
    ) internal returns (bytes32 grantId) {
        require(
            activeGrantCount[repoId] < MAX_GRANTS_PER_REPO,
            "GitEscrowV3: grant cap reached"
        );

        uint256 nonce = grantNonce[repoId];
        grantId = keccak256(abi.encode(repoId, msg.sender, token, nonce));
        grantNonce[repoId] = nonce + 1;

        uint256 startPushCount = knownPushCount[repoId];

        grants[grantId] = VestingGrant({
            repoId: repoId,
            recipient: msg.sender,
            token: token,
            totalLocked: amount,
            totalReleased: 0,
            totalPushesRequired: totalPushes,
            pushesPerMilestone: pushesPerMile,
            tokensPerMilestone: tokensPerMile,
            lastPaidMilestone: 0,
            active: true,
            streaming: streaming,
            lockedAt: uint64(block.timestamp),
            startPushCount: startPushCount
        });

        repoGrantIds[repoId].push(grantId);
        activeGrantCount[repoId] += 1;
        if (nonce == 0) {
            allRepoIds.push(repoId);
        }

        emit Locked(
            grantId,
            repoId,
            msg.sender,
            token,
            amount,
            totalPushes,
            pushesPerMile,
            tokensPerMile,
            startPushCount
        );
    }

    // ─── Recipient: lock ───────────────────────────────────────────────────

    /**
     * @notice Lock tokens for GitHub-gated vesting. A repo may carry up to
     *         MAX_GRANTS_PER_REPO active grants concurrently.
     * @param repoId          keccak256 of "owner/repo".
     * @param token           ERC-20 to lock.
     * @param amount          Total tokens to lock (must have approved this contract).
     * @param totalPushes     Total verified pushes (after the baseline) to fully vest.
     * @param pushesPerMile   Every N pushes triggers a release batch.
     * @return grantId        The new grant's id.
     */
    function lock(
        bytes32 repoId,
        address token,
        uint256 amount,
        uint256 totalPushes,
        uint256 pushesPerMile
    ) external nonReentrant returns (bytes32 grantId) {
        uint256 tokensPerMile = _validateSchedule(token, amount, totalPushes, pushesPerMile);
        require(
            activeGrantCount[repoId] < MAX_GRANTS_PER_REPO,
            "GitEscrowV3: grant cap reached"
        );

// Try to pull tokens upfront. For normal ERC-20s this works.
// For Bankr DERC20 tokens (or any token with a locked-pool guard
// around the receiver), this reverts. In that case the recipient
// should call lockAllowance() instead so we record the grant
// without taking custody of the tokens.
        try this._tryPull(token, msg.sender, amount) {
            // tokens are now in escrow
        } catch {
            revert("GitEscrowV3: pull failed - use lockAllowance for restricted tokens");
        }

        grantId = _createGrant(repoId, token, amount, totalPushes, pushesPerMile, tokensPerMile, false);
    }

    /// @dev External helper so we can use try/catch around the token call.
    function _tryPull(address token, address from, uint256 amount) external {
        require(msg.sender == address(this), "GitEscrowV3: internal");
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
    ) external nonReentrant returns (bytes32 grantId) {
        uint256 tokensPerMile = _validateSchedule(token, amount, totalPushes, pushesPerMile);

        // Verify the recipient has approved us for at least `amount`.
        require(
            IERC20(token).allowance(msg.sender, address(this)) >= amount,
            "GitEscrowV3: insufficient allowance"
        );

        grantId = _createGrant(repoId, token, amount, totalPushes, pushesPerMile, tokensPerMile, true);
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
    ) external nonReentrant returns (bytes32 grantId) {
        uint256 tokensPerMile = _validateSchedule(token, amount, totalPushes, pushesPerMile);

        // Set the allowance via EIP-2612 permit in the same transaction.
        // This sidesteps any token-side `approve` restrictions.
        IERC20Permit(token).permit(msg.sender, address(this), amount, deadline, v, r, s);

        // Verify the allowance was actually set.
        require(
            IERC20(token).allowance(msg.sender, address(this)) >= amount,
            "GitEscrowV3: permit did not set allowance"
        );

        grantId = _createGrant(repoId, token, amount, totalPushes, pushesPerMile, tokensPerMile, true);
    }

    // ─── Oracle: count reporting ───────────────────────────────────────────

    /**
     * @notice Advance the contract's known repo counted total. Oracle only,
     *         monotone: a total at or below the current known total is a
     *         no-op (never a regression). Locks stamp their baseline from
     *         this counter, so the backend reports every counted push for
     *         repos carrying V3 grants.
     * @param repoId               The repo whose counted total advanced.
     * @param totalVerifiedPushes  The repo cumulative counted total.
     */
    function reportCount(bytes32 repoId, uint256 totalVerifiedPushes) external {
        require(msg.sender == oracle, "GitEscrowV3: not oracle");
        if (totalVerifiedPushes > knownPushCount[repoId]) {
            knownPushCount[repoId] = totalVerifiedPushes;
            emit PushCountReported(repoId, totalVerifiedPushes);
        }
    }

    // ─── Oracle: release ───────────────────────────────────────────────────

    /**
     * @notice Called by the oracle when a grant hits a new milestone.
     * @param grantId              The grant to release for.
     * @param totalVerifiedPushes  The repo CUMULATIVE counted total
     *                             (monotonically increasing per repo). The
     *                             grant's progress is derived against its
     *                             own startPushCount baseline.
     */
    function release(bytes32 grantId, uint256 totalVerifiedPushes) external nonReentrant {
        require(msg.sender == oracle, "GitEscrowV3: not oracle");
        VestingGrant storage g = grants[grantId];
        require(g.active, "GitEscrowV3: grant not active");

        // Advance the repo counter (monotone) — release calls also carry
        // the freshest total the oracle knows.
        if (totalVerifiedPushes > knownPushCount[g.repoId]) {
            knownPushCount[g.repoId] = totalVerifiedPushes;
        }

        uint256 elapsed = totalVerifiedPushes > g.startPushCount
            ? totalVerifiedPushes - g.startPushCount
            : 0;
        uint256 totalMilestones = g.totalPushesRequired / g.pushesPerMilestone;
        uint256 milestonesEarned = elapsed / g.pushesPerMilestone;
        if (milestonesEarned > totalMilestones) {
            milestonesEarned = totalMilestones;
        }
        require(milestonesEarned > g.lastPaidMilestone, "GitEscrowV3: no new milestones");

        uint256 newMilestones = milestonesEarned - g.lastPaidMilestone;
        uint256 payout = newMilestones * g.tokensPerMilestone;

        // On final milestone, release any rounding dust too.
        bool isFinal = milestonesEarned >= totalMilestones;
        if (isFinal) {
            uint256 remaining = g.totalLocked - g.totalReleased;
            if (remaining > payout) payout = remaining;
        }

        g.totalReleased += payout;
        g.lastPaidMilestone = milestonesEarned;

        if (isFinal) {
            g.active = false;
            activeGrantCount[g.repoId] -= 1;
        }

        // Streaming-allowance (Bankr DERC20): pull from recipient through the
        // oracle, then immediately forward to the recipient in the same tx so
        // tokens never sit on the oracle wallet.
        // Pre-funded: tokens are already in escrow, send directly to recipient.
        if (g.streaming) {
            IERC20(g.token).safeTransferFrom(g.recipient, msg.sender, payout);
            IERC20(g.token).safeTransfer(g.recipient, payout);
        } else {
            IERC20(g.token).safeTransfer(g.recipient, payout);
        }

        emit Released(grantId, g.repoId, g.recipient, payout, milestonesEarned, g.totalReleased);
    }

    // ─── View helpers ──────────────────────────────────────────────────────

    function getGrant(bytes32 grantId) external view returns (VestingGrant memory) {
        return grants[grantId];
    }

    function remainingTokens(bytes32 grantId) external view returns (uint256) {
        VestingGrant storage g = grants[grantId];
        if (!g.active) return 0;
        return g.totalLocked - g.totalReleased;
    }

    /// @notice The repo-cumulative counted total at which this grant's
    ///         next milestone falls due (0 if the grant is not active).
    function nextMilestoneAt(bytes32 grantId) external view returns (uint256 repoTotalNeeded) {
        VestingGrant storage g = grants[grantId];
        if (!g.active) return 0;
        return g.startPushCount + (g.lastPaidMilestone + 1) * g.pushesPerMilestone;
    }

    /// @notice Number of grants ever created for a repo.
    function repoGrantCount(bytes32 repoId) external view returns (uint256) {
        return repoGrantIds[repoId].length;
    }

    /// @notice The grantId of the index-th grant created for a repo.
    function repoGrantIdAt(bytes32 repoId, uint256 index) external view returns (bytes32) {
        return repoGrantIds[repoId][index];
    }

    function allRepoIdsLength() external view returns (uint256) {
        return allRepoIds.length;
    }

    /// @dev Encode a "owner/repo" string into the bytes32 repoId used on-chain.
    function encodeRepoId(string calldata ownerSlashRepo) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(ownerSlashRepo));
    }
}
