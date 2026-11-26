// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockFeeClaimSource
 * @notice TEST-ONLY double modelling the Bankr fee LEDGER's claim leg
 *         (BankrFeeLedger on Base): trading fees accrue per
 *         fee-recipient (beneficiary) and are claimed by the
 *         beneficiary calling collectFees(bucketId) — the SDK's
 *         buildClaim semantics (beneficiary-signed; claimable → 0
 *         after a claim, exactly as proven with buildClaim in report
 *         §5). It also models the ledger's claim-policy surface
 *         (setClaimRestricted / claimRestricted) that a contract fee
 *         recipient must use before a launch may name it. Stands in
 *         for the real ledger in local tests; never deployed anywhere
 *         real.
 */
contract MockFeeClaimSource {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    mapping(address => uint256) public claimable;
    mapping(address => bool) public claimRestricted;

    event FeesAccrued(address indexed beneficiary, uint256 amount);
    event FeesClaimed(address indexed beneficiary, uint256 amount);

    constructor(address _token) {
        token = IERC20(_token);
    }

    /// Test helper: record newly accrued fees for a beneficiary
    /// (models trading fees landing on the pad between claims).
    function accrue(address beneficiary, uint256 amount) external {
        claimable[beneficiary] += amount;
        emit FeesAccrued(beneficiary, amount);
    }

    /// Ledger claim policy: an account restricts who may claim for it.
    /// The FeeLockVault calls this on itself in its constructor.
    function setClaimRestricted(bool restricted) external {
        claimRestricted[msg.sender] = restricted;
    }

    /// The real ledger's claim entry point (buildClaim's calldata):
    /// pays the CALLER its accrued amount. The bucket id is ignored —
    /// this double keeps one bucket per beneficiary.
    function collectFees(bytes32) external returns (uint128, uint128) {
        uint256 amount = claimable[msg.sender];
        require(amount > 0, "MockFeeClaimSource: nothing claimable");
        claimable[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit FeesClaimed(msg.sender, amount);
        return (0, uint128(amount));
    }

    /// Legacy no-arg claim (kept for older fixtures): pays the CALLER.
    function claim() external returns (uint256 amount) {
        amount = claimable[msg.sender];
        require(amount > 0, "MockFeeClaimSource: nothing claimable");
        claimable[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit FeesClaimed(msg.sender, amount);
    }
}
