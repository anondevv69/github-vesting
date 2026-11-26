// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The Bankr fee ledger's claim surface — the REAL claim
///         mechanism (Bankr launch SDK, `fees.buildClaim`): the SDK
///         builds transactions TO the ledger carrying one of these
///         three calls, sent BY the beneficiary; the ledger pays the
///         caller (msg.sender) its accrued share of the bucket. The
///         vault executes exactly this calldata, so the vault itself
///         is the beneficiary-signer of every claim.
interface IBankrFeeLedger {
    function collectFees(bytes32 bucketId) external returns (uint128, uint128);
    function collectFeesMany(bytes32[] calldata bucketIds) external returns (uint128[] memory, uint128[] memory);
    function collectFeesSide(bytes32 bucketId, bool isCurrency0) external returns (uint256);
    function setClaimRestricted(bool restricted) external;
}

/// @notice Mirror of FeeStreamEscrow.CountAttestation — the
///         oracle-signed backend counted-push total (EIP-712). The
///         vault passes it through verbatim; the escrow verifies
///         the oracle's signature and the bindings itself.
struct CountAttestation {
    address escrow;
    bytes32 repoId;
    address vault;
    uint256 countedTotal;
    uint256 issuedAt;
    uint256 expiry;
    uint256 nonce;
}

interface IFeeStreamEscrow {
    function addFeeTranche(
        bytes32 repoId,
        uint256 amount,
        uint256 expectedBaseline,
        CountAttestation calldata att,
        bytes calldata signature
    ) external;
}

/**
 * @title FeeLockVault
 * @notice The claim-capable fee recipient for ONE Proof of Dev project
 *         (Gregory's decided fee-lock rule, 2026-11-25). A platform
 *         launch names this vault — never the launcher's raw wallet —
 *         as the launcher-share fee recipient, so trading fees can
 *         never arrive liquid:
 *
 *           fees accrue → vault claims them → keeper calls
 *           lockAccrued() → the full balance locks into the project's
 *           FeeStreamEscrow fee grant → tranches release to the
 *           launcher only as counted pushes land (oracle path).
 *
 * SECURITY INVARIANT — outbound paths: this contract has exactly TWO
 * state-changing functions, claimFees() (pulls fees IN from the fee
 * ledger) and lockAccrued() (pushes the vault's whole token balance
 * into its FeeStreamEscrow grant). There is deliberately NO withdraw,
 * sweep, rescue, or arbitrary-transfer function, and no function that
 * can send funds to the launcher or any other address. The escrow is
 * the only possible destination, fixed at construction. claimFees is
 * equally constrained: it may call ONLY the immutable claim ledger,
 * and ONLY with one of the three SDK claim selectors — the ledger
 * pays the caller (this vault), so no claim call can move funds
 * anywhere else.
 *
 * CLAIM-RESTRICTION (why the constructor calls the ledger): Bankr's
 * factory refuses a contract fee recipient that "lets anyone claim
 * for it" (LaunchRefusedError FEE_RECIPIENT_CANNOT_CLAIM /
 * factory OpenContractFeeRecipient). The SDK's prescribed fix is
 * that the contract restricts its own claim policy on the ledger
 * first — ideally in its constructor. This vault does exactly that:
 * setClaimRestricted(true) at construction, so only the vault itself
 * can ever claim its share, and a stranger's settle cannot move the
 * share into a pull balance the vault would lose track of.
 *
 * Denomination: the vault locks the asset it holds (the fee token set
 * at construction — WETH as claimed from the pad). A swap-to-project-
 * token step is a documented, config-gated future option and is NOT
 * implemented here.
 */
contract FeeLockVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    event FeesClaimed(address indexed ledger, uint256 amount);
    event FeesLocked(uint256 amount);

    /// The fee-stream escrow this vault locks into. Immutable.
    address public immutable escrow;
    /// The fee asset (the token fees are paid/claimed in). Immutable.
    address public immutable feeToken;
    /// The repo this vault serves. Immutable.
    bytes32 public immutable repoId;
    /// The launcher (informational — the vault can never pay it directly;
    /// releases flow escrow → launcher through the oracle path only).
    address public immutable launcher;
    /// The Bankr fee ledger this vault claims from. Immutable. On Base
    /// mainnet: 0x7C836e937831Cd5931A1ACbB9117dF9714D7d1F7.
    address public immutable claimLedger;

    constructor(
        address _escrow,
        address _feeToken,
        bytes32 _repoId,
        address _launcher,
        address _claimLedger
    ) {
        require(_escrow != address(0), "FeeLockVault: zero escrow");
        require(_feeToken != address(0), "FeeLockVault: zero token");
        require(_launcher != address(0), "FeeLockVault: zero launcher");
        require(_claimLedger != address(0), "FeeLockVault: zero ledger");
        escrow = _escrow;
        feeToken = _feeToken;
        repoId = _repoId;
        launcher = _launcher;
        claimLedger = _claimLedger;
        // Restrict this vault's claim policy on the ledger BEFORE it
        // can be named as a fee recipient (see header). Fail-closed:
        // if the ledger refuses, the vault does not exist.
        IBankrFeeLedger(_claimLedger).setClaimRestricted(true);
    }

    /**
     * @notice Claim this vault's accrued fees from the fee ledger
     *         (permissionless — anyone, e.g. the keeper, may trigger;
     *         the ledger pays the VAULT as beneficiary, never the
     *         caller). `data` is the exact claim calldata built by
     *         the Bankr SDK (`fees.buildClaim`): one of collectFees /
     *         collectFeesMany / collectFeesSide, nothing else — the
     *         selector allowlist is what keeps this function an
     *         inbound-only path. Returns the fee-token amount that
     *         landed in the vault (the claim also pays the launched
     *         token's side when the bucket holds any; that side is
     *         not the fee token and is not measured here).
     */
    function claimFees(bytes calldata data) external nonReentrant returns (uint256 amount) {
        require(data.length >= 4, "FeeLockVault: empty claim data");
        bytes4 selector;
        assembly {
            selector := calldataload(data.offset)
        }
        require(
            selector == IBankrFeeLedger.collectFees.selector ||
                selector == IBankrFeeLedger.collectFeesMany.selector ||
                selector == IBankrFeeLedger.collectFeesSide.selector,
            "FeeLockVault: not a claim call"
        );
        uint256 before = IERC20(feeToken).balanceOf(address(this));
        (bool ok, bytes memory ret) = claimLedger.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        amount = IERC20(feeToken).balanceOf(address(this)) - before;
        if (amount > 0) emit FeesClaimed(claimLedger, amount);
    }

    /**
     * @notice Lock the vault's full accrued fee-token balance into the
     *         project's fee-stream grant as a new tranche
     *         (permissionless keeper step). This is the vault's ONLY
     *         outbound path. `expectedBaseline` binds the tranche to
     *         the escrow's current on-chain counted-push total: the
     *         escrow reverts if its total has moved since the keeper
     *         read it. The backend counted total is NO LONGER a bare
     *         parameter (round 4): it arrives as an EIP-712
     *         CountAttestation signed by the escrow's oracle, which
     *         the escrow verifies itself (signer, escrow/repo/vault
     *         bindings, expiry, monotone nonce + total). This vault
     *         verifies nothing about it — it passes the attestation
     *         and signature through verbatim, so no caller of this
     *         function can inject a count the oracle never signed.
     *         The escrow stamps the tranche with max(on-chain total,
     *         attested total), so the tranche can never vest against
     *         a push counted before the fees locked, in either
     *         counter.
     */
    function lockAccrued(
        uint256 expectedBaseline,
        CountAttestation calldata att,
        bytes calldata signature
    ) external nonReentrant returns (uint256 amount) {
        amount = IERC20(feeToken).balanceOf(address(this));
        require(amount > 0, "FeeLockVault: nothing accrued");
        IERC20(feeToken).forceApprove(escrow, amount);
        IFeeStreamEscrow(escrow).addFeeTranche(repoId, amount, expectedBaseline, att, signature);
        emit FeesLocked(amount);
    }

    /// Accrued, not-yet-locked fee balance sitting in the vault.
    function accrued() external view returns (uint256) {
        return IERC20(feeToken).balanceOf(address(this));
    }
}
