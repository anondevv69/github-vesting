// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title TimeLockVault
/// @notice Trustless time-based ERC-20 locker. Each lock is an ERC-721 NFT
///         with on-chain animated SVG metadata. No owner, no admin, no early release.
/// @dev    Compile with Solidity 0.8.24, optimizer 200 runs, via-IR, EVM cancun.

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

contract TimeLockVault is ERC721, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    struct Lock {
        address token;
        uint256 amount;
        uint256 unlockTime;
        bool withdrawn;
        address depositor;
        uint256 createdAt;
    }

    error LockNotExpired();
    error AlreadyWithdrawn();
    error NotLockOwner();
    error ZeroAmount();
    error ZeroLockTime();
    error ZeroToken();
    error InvalidLockId();
    error UnlockOverflow();

    mapping(uint256 => Lock) public locks;
    uint256 public nextLockId = 1;

    event Deposited(
        uint256 indexed lockId,
        address indexed depositor,
        address indexed token,
        uint256 amount,
        uint256 unlockTime
    );
    event Withdrawn(uint256 indexed lockId, address indexed withdrawer, uint256 amount);
    event LockExtended(uint256 indexed lockId, uint256 newUnlockTime);

    constructor() ERC721("TimeLock Vault", "TLV") {}

    /// @notice Lock ERC-20 tokens for a duration. Mints an NFT representing the lock.
    /// @param token     ERC-20 contract address
    /// @param amount    Amount of tokens to lock (smallest unit)
    /// @param lockTime  Duration in seconds (e.g. 420 days = 36_288_000)
    /// @return lockId   NFT token ID for this lock
    function deposit(address token, uint256 amount, uint256 lockTime)
        external
        nonReentrant
        returns (uint256 lockId)
    {
        if (token == address(0)) revert ZeroToken();
        if (amount == 0) revert ZeroAmount();
        if (lockTime == 0) revert ZeroLockTime();

        uint256 unlockTime = block.timestamp + lockTime;
        if (unlockTime < block.timestamp) revert UnlockOverflow();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        lockId = nextLockId++;
        locks[lockId] = Lock({
            token: token,
            amount: amount,
            unlockTime: unlockTime,
            withdrawn: false,
            depositor: msg.sender,
            createdAt: block.timestamp
        });

        _mint(msg.sender, lockId);

        emit Deposited(lockId, msg.sender, token, amount, unlockTime);
    }

    /// @notice Withdraw locked tokens after unlockTime. Burns the lock NFT.
    function withdraw(uint256 lockId) external nonReentrant {
        _requireActiveLockOwner(lockId);
        Lock storage l = locks[lockId];

        if (l.withdrawn) revert AlreadyWithdrawn();
        if (block.timestamp < l.unlockTime) revert LockNotExpired();

        l.withdrawn = true;
        uint256 amount = l.amount;
        IERC20(l.token).safeTransfer(msg.sender, amount);
        _burn(lockId);

        emit Withdrawn(lockId, msg.sender, amount);
    }

    /// @notice Extend the lock. Can only add time; reverts if already withdrawn.
    function extendLock(uint256 lockId, uint256 additionalSec) external {
        _requireActiveLockOwner(lockId);
        Lock storage l = locks[lockId];

        if (l.withdrawn) revert AlreadyWithdrawn();
        if (additionalSec == 0) revert ZeroLockTime();

        uint256 newUnlock = l.unlockTime + additionalSec;
        if (newUnlock < l.unlockTime) revert UnlockOverflow();

        l.unlockTime = newUnlock;
        emit LockExtended(lockId, newUnlock);
    }

    function getLock(uint256 lockId) external view returns (Lock memory) {
        _requireExistingLock(lockId);
        return locks[lockId];
    }

    function isUnlocked(uint256 lockId) external view returns (bool) {
        _requireExistingLock(lockId);
        return block.timestamp >= locks[lockId].unlockTime;
    }

    function timeRemaining(uint256 lockId) external view returns (uint256) {
        _requireExistingLock(lockId);
        uint256 u = locks[lockId].unlockTime;
        return block.timestamp >= u ? 0 : u - block.timestamp;
    }

    function tokenURI(uint256 lockId) public view override returns (string memory) {
        _requireExistingLock(lockId);

        Lock memory l = locks[lockId];
        bool unlocked = block.timestamp >= l.unlockTime;

        uint256 seed = uint256(keccak256(abi.encodePacked(lockId, l.token, l.amount, l.unlockTime)));

        uint256 hue1 = seed % 360;
        uint256 hue2 = (seed >> 8) % 360;
        uint256 hue3 = (seed >> 16) % 360;

        string memory statusText = l.withdrawn ? "WITHDRAWN" : unlocked ? "UNLOCKED" : "LOCKED";
        string memory statusColor = l.withdrawn ? "#6b7280" : unlocked ? "#22c55e" : "#ef4444";

        uint256 remaining = unlocked ? 0 : (l.unlockTime - block.timestamp);
        string memory timeStr = l.withdrawn
            ? "Claimed"
            : unlocked
                ? "Available now"
                : _formatDuration(remaining);

        string memory svg = string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">',
            '<defs>',
            '<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">',
            '<stop offset="0%" stop-color="hsl(', hue1.toString(), ',60%,8%)"/>',
            '<stop offset="100%" stop-color="hsl(', hue2.toString(), ',60%,15%)"/>',
            '</linearGradient>',
            '<filter id="glow"><feGaussianBlur stdDeviation="4" result="b"/>',
            '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
            '</defs>',
            '<rect width="400" height="400" fill="url(#bg)"/>',
            '<circle cx="200" cy="200" r="150" fill="none" stroke="hsl(', hue1.toString(),
            ',70%,50%)" stroke-width="2" opacity="0.4">',
            '<animateTransform attributeName="transform" type="rotate" from="0 200 200" to="360 200 200" dur="20s" repeatCount="indefinite"/>',
            '</circle>',
            '<circle cx="200" cy="200" r="120" fill="none" stroke="hsl(', hue2.toString(),
            ',70%,50%)" stroke-width="2" opacity="0.5">',
            '<animateTransform attributeName="transform" type="rotate" from="360 200 200" to="0 200 200" dur="15s" repeatCount="indefinite"/>',
            '</circle>',
            '<circle cx="200" cy="200" r="90" fill="hsl(', hue3.toString(),
            ',70%,50%)" opacity="0.08" filter="url(#glow)">',
            '<animate attributeName="r" values="80;100;80" dur="3s" repeatCount="indefinite"/>',
            '<animate attributeName="opacity" values="0.05;0.15;0.05" dur="3s" repeatCount="indefinite"/>',
            '</circle>',
            '<g transform="translate(200,200)">',
            '<rect x="-25" y="-5" width="50" height="45" rx="6" fill="hsl(', hue1.toString(),
            ',60%,30%)" stroke="hsl(', hue1.toString(), ',70%,60%)" stroke-width="2"/>',
            '<path d="M -15,-5 Q -15,-25 0,-25 Q 15,-25 15,-5" fill="none" stroke="hsl(', hue1.toString(),
            ',70%,60%)" stroke-width="3"/>',
            '<circle cx="0" cy="15" r="5" fill="hsl(', hue3.toString(), ',80%,60%)"/>',
            '<animateTransform attributeName="transform" type="translate" values="200,200;200,195;200,200" dur="4s" repeatCount="indefinite"/>',
            '</g>',
            '<text x="200" y="310" text-anchor="middle" font-family="monospace" font-size="22" font-weight="bold" fill="',
            statusColor, '">', statusText, '</text>',
            '<text x="200" y="340" text-anchor="middle" font-family="monospace" font-size="13" fill="#888">',
            timeStr, '</text>',
            '<text x="200" y="370" text-anchor="middle" font-family="monospace" font-size="11" fill="#555">',
            'Lock #', lockId.toString(), '</text>',
            '</svg>'
        ));

        string memory json = string(abi.encodePacked(
            '{"name":"TimeLock #', lockId.toString(), '"',
            ',"description":"Time-locked ERC-20 tokens. NFT ownership = withdrawal rights until claimed. No early release."',
            ',"image_data":"', svg, '"',
            ',"external_url":"https://bankr.bot"',
            ',"attributes":[',
            '{"trait_type":"Status","value":"', statusText, '"},',
            '{"trait_type":"Token","value":"', _addressShort(l.token), '"},',
            '{"trait_type":"Amount","value":"', l.amount.toString(), '"},',
            '{"trait_type":"Unlock Time","value":"', l.unlockTime.toString(), '"},',
            '{"trait_type":"Depositor","value":"', _addressShort(l.depositor), '"},',
            '{"trait_type":"Withdrawn","value":"', l.withdrawn ? "true" : "false", '"}',
            ']}'
        ));

        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    function _requireExistingLock(uint256 lockId) internal view {
        if (lockId == 0 || lockId >= nextLockId) revert InvalidLockId();
    }

    function _requireActiveLockOwner(uint256 lockId) internal view {
        _requireExistingLock(lockId);
        if (_ownerOf(lockId) == address(0)) revert InvalidLockId();
        if (ownerOf(lockId) != msg.sender) revert NotLockOwner();
    }

    function _formatDuration(uint256 seconds_) internal pure returns (string memory) {
        if (seconds_ == 0) return "0s";
        uint256 days_ = seconds_ / 86_400;
        uint256 hours_ = (seconds_ % 86_400) / 3600;
        if (days_ > 0) {
            return string(abi.encodePacked(days_.toString(), "d ", hours_.toString(), "h remaining"));
        }
        uint256 mins_ = (seconds_ % 3600) / 60;
        return string(abi.encodePacked(hours_.toString(), "h ", mins_.toString(), "m remaining"));
    }

    function _addressShort(address a) internal pure returns (string memory) {
        return string(abi.encodePacked(
            "0x",
            _toHex(uint16(uint160(a) >> 144)),
            "...",
            _toHex(uint16(uint160(a)))
        ));
    }

    function _toHex(uint16 value) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(4);
        for (uint256 i = 0; i < 4; i++) {
            str[3 - i] = alphabet[value & 0xf];
            value >>= 4;
        }
        return string(str);
    }
}
