// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ShipRewards
 * @notice Pre-funded ERC-20 reward pool for verified merged PRs (Ship spec §8B).
 *
 * Flow:
 *   1. Owner deploys with an oracle + reward token, then funds the pool by
 *      transferring reward tokens to this contract (plain ERC-20 transfer —
 *      any amount, any time; the pool is finite by design, no minting).
 *   2. Oracle (bot service) calls pay() once per counted merge, keyed by the
 *      merge commit hash. A hash can only ever be paid once.
 *   3. Owner can rotate the oracle, change the reward token, and withdraw
 *      remaining tokens (e.g. to close or migrate the pool).
 *
 * Trust model mirrors GitEscrow: anti-gaming lives off-chain in the bot's
 * push verifier; this contract only trusts the oracle's pay() calls and
 * enforces one-payment-per-merge on-chain.
 */
contract ShipRewards is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Events ────────────────────────────────────────────────────────────

    event Paid(
        bytes32 indexed repoId,
        address indexed recipient,
        uint256 amount,
        bytes32 indexed mergeCommitHash
    );
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event RewardTokenUpdated(address indexed oldToken, address indexed newToken);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    // ─── Storage ───────────────────────────────────────────────────────────

    /// Address authorised to call pay() — the bot oracle wallet.
    address public oracle;

    /// The ERC-20 paid out as the per-merge reward.
    address public rewardToken;

    /// mergeCommitHash → already paid. On-chain idempotency: a webhook
    /// redelivery or oracle retry can never pay the same merge twice.
    /// The hash is keccak256 of the merge commit SHA string (oracle-side).
    mapping(bytes32 => bool) public paid;

    /// Running total paid out (in reward-token units).
    uint256 public totalPaid;

    // ─── Constructor ───────────────────────────────────────────────────────

    constructor(address _oracle, address _rewardToken) Ownable(msg.sender) {
        require(_oracle != address(0), "ShipRewards: zero oracle");
        require(_rewardToken != address(0), "ShipRewards: zero token");
        oracle = _oracle;
        rewardToken = _rewardToken;
        emit OracleUpdated(address(0), _oracle);
        emit RewardTokenUpdated(address(0), _rewardToken);
    }

    // ─── Owner ─────────────────────────────────────────────────────────────

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "ShipRewards: zero oracle");
        emit OracleUpdated(oracle, _oracle);
        oracle = _oracle;
    }

    function setRewardToken(address _rewardToken) external onlyOwner {
        require(_rewardToken != address(0), "ShipRewards: zero token");
        emit RewardTokenUpdated(rewardToken, _rewardToken);
        rewardToken = _rewardToken;
    }

    /**
     * @notice Withdraw tokens from the pool (any ERC-20, so a retired reward
     *         token or an accidental transfer can be recovered by the owner).
     */
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(token != address(0) && to != address(0), "ShipRewards: zero address");
        require(amount > 0, "ShipRewards: zero amount");
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    // ─── Oracle: pay one counted merge ─────────────────────────────────────

    /**
     * @notice Pay the per-merge reward for one counted merge.
     * @param repoId           keccak256 of "owner/repo" (same encoding as GitEscrow).
     * @param recipient        The PR author's linked wallet.
     * @param amount           Reward amount in reward-token units.
     * @param mergeCommitHash  Unique key for this merge (keccak256 of its SHA).
     */
    function pay(
        bytes32 repoId,
        address recipient,
        uint256 amount,
        bytes32 mergeCommitHash
    ) external nonReentrant {
        require(msg.sender == oracle, "ShipRewards: not oracle");
        require(recipient != address(0), "ShipRewards: zero recipient");
        require(amount > 0, "ShipRewards: zero amount");
        require(mergeCommitHash != bytes32(0), "ShipRewards: zero commit hash");
        require(!paid[mergeCommitHash], "ShipRewards: merge already paid");

        // Effects before interaction — and a revert anywhere below rolls the
        // flag back, so a failed transfer never burns the merge's payment.
        paid[mergeCommitHash] = true;
        totalPaid += amount;

        IERC20(rewardToken).safeTransfer(recipient, amount);

        emit Paid(repoId, recipient, amount, mergeCommitHash);
    }

    // ─── View helpers ──────────────────────────────────────────────────────

    /// Remaining reward-token balance available for future merges.
    function rewardBalance() external view returns (uint256) {
        return IERC20(rewardToken).balanceOf(address(this));
    }

    function isPaid(bytes32 mergeCommitHash) external view returns (bool) {
        return paid[mergeCommitHash];
    }

    /// @dev Encode a "owner/repo" string into the bytes32 repoId used on-chain.
    function encodeRepoId(string calldata ownerSlashRepo) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(ownerSlashRepo));
    }
}
