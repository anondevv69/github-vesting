// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockVaultImpostor
 * @notice TEST-ONLY: a contract exposing the same immutable-binding
 *         getters as FeeLockVault (escrow / feeToken / repoId /
 *         launcher / claimLedger) but with DIFFERENT runtime code —
 *         its codehash can never equal a real FeeLockVault's. Used by
 *         the launch-recognition tests to prove registration pins the
 *         vault's codehash at prepare time and refuses a substituted
 *         contract at registration even when its reported bindings
 *         look right. Never deployed anywhere real.
 */
contract MockVaultImpostor {
    address public immutable escrow;
    address public immutable feeToken;
    bytes32 public immutable repoId;
    address public immutable launcher;
    address public immutable claimLedger;

    constructor(
        address _escrow,
        address _feeToken,
        bytes32 _repoId,
        address _launcher,
        address _claimLedger
    ) {
        escrow = _escrow;
        feeToken = _feeToken;
        repoId = _repoId;
        launcher = _launcher;
        claimLedger = _claimLedger;
    }

    /// Marker that exists only here — guarantees distinct bytecode.
    function impostorMarker() external pure returns (string memory) {
        return "not a FeeLockVault";
    }
}
