// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockBankrLaunchRecord
 * @notice TEST-ONLY double implementing the three read surfaces the
 *         launch-recognition checker (src/lib/launchRecognition.ts)
 *         uses against Bankr's real contracts on Base:
 *           factory.poolOf(token)            → (poolId, PoolKey)
 *           ledger.beneficiariesOf(bucketId) → address[]
 *           ledger.creatorShareOf(bucketId, account) → wad
 *         One contract plays both roles in tests (the checker takes
 *         the factory and ledger addresses from chain config, and the
 *         E2E env points both at this double). The bucket id is the
 *         real derivation — keccak256(encodePacked(poolId, "creator"))
 *         — computed by the test driver, exactly as the SDK's lens
 *         computes it. Never deployed anywhere real.
 */
contract MockBankrLaunchRecord {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    mapping(address => bytes32) public poolIds;
    mapping(bytes32 => address[]) internal _beneficiaries;
    mapping(bytes32 => mapping(address => uint256)) public creatorShareOf;

    /// Test helper: record a launch's fee configuration.
    function setLaunch(
        address token,
        bytes32 poolId,
        bytes32 bucketId,
        address[] calldata recipients,
        uint256[] calldata creatorShareWads
    ) external {
        require(recipients.length == creatorShareWads.length, "MockBankrLaunchRecord: length mismatch");
        poolIds[token] = poolId;
        delete _beneficiaries[bucketId];
        for (uint256 i = 0; i < recipients.length; i++) {
            _beneficiaries[bucketId].push(recipients[i]);
            creatorShareOf[bucketId][recipients[i]] = creatorShareWads[i];
        }
    }

    function poolOf(address token) external view returns (bytes32, PoolKey memory) {
        return (poolIds[token], PoolKey(address(0), address(0), 0, 0, address(0)));
    }

    function beneficiariesOf(bytes32 bucketId) external view returns (address[] memory) {
        return _beneficiaries[bucketId];
    }
}
