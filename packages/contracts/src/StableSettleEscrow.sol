// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title StableSettleEscrow
/// @notice Turns a single cross-border order into a programmable settlement contract.
///         The order total is split into four buckets — merchant, refund reserve,
///         creator commission, platform fee — locked on funding and released or
///         resolved based on what happens to the package.
/// @dev Settlement token is supplied at construction. Point it at Arc's native USDC
///      (0x3600...0000, 6 decimals) for production, or at MockUSDC for a self-contained demo.
contract StableSettleEscrow is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Roles
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice May create orders. The merchant / platform operator.
    bytes32 public constant MERCHANT_ROLE = keccak256("MERCHANT_ROLE");
    /// @notice May report delivery status and raise disputes. The delivery oracle.
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    /// @notice May resolve disputes and clear anomalies. In production this should be a multisig.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Actual duties above this multiple of the estimate auto-flag the order for review.
    uint256 public constant DUTIES_ANOMALY_MULTIPLE = 2;

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The six lifecycle states. Created→Funded→Delivered→Released is the
    ///         happy path; Disputed→Resolved is the dispute branch.
    enum OrderState {
        Created,
        Funded,
        Delivered,
        Released,
        Disputed,
        Resolved
    }

    /// @notice Recipients and the four bucket amounts. Bucket amounts must sum to the order total.
    struct Split {
        address merchant;
        address creator;
        address platform;
        address customer;
        uint256 merchantAmount;
        uint256 refundReserve;
        uint256 creatorCommission;
        uint256 platformFee;
    }

    struct Order {
        uint256 totalAmount;
        uint256 deliveredAt; // 0 until Delivered
        uint256 refundWindowSeconds; // demo: 0–30s; prod: 7–14 days
        uint256 estimatedDuties; // import duties quoted at checkout (0 = not tracked)
        uint256 actualDuties; // duties reported at customs; 0 until reported
        address token; // settlement token for this order (USDC or EURC)
        OrderState state;
        bool settled; // true once funds have left the contract (Released or Resolved)
        bool anomalyFlagged; // actual duties came in far above estimate — release is blocked
        Split split;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The default settlement token (USDC). Used when an order doesn't specify one.
    ///         Orders may settle in any ERC-20 (e.g. EURC) by passing a token to createOrder.
    IERC20 public immutable defaultToken;

    /// @notice orderId => order. orderId is a caller-supplied bytes32 (e.g. keccak of an order number).
    mapping(bytes32 => Order) private _orders;

    // ─────────────────────────────────────────────────────────────────────────
    // Events — the dashboard's audit log is built entirely from these.
    // ─────────────────────────────────────────────────────────────────────────

    event OrderCreated(
        bytes32 indexed orderId,
        uint256 totalAmount,
        uint256 refundWindowSeconds,
        uint256 estimatedDuties,
        address token,
        address merchant,
        address creator,
        address platform,
        address customer,
        uint256 merchantAmount,
        uint256 refundReserve,
        uint256 creatorCommission,
        uint256 platformFee,
        string productName,
        string customerCountry
    );
    event OrderFunded(bytes32 indexed orderId, address indexed funder, uint256 totalAmount);
    event Delivered(bytes32 indexed orderId, uint256 deliveredAt);
    event Released(
        bytes32 indexed orderId,
        uint256 merchantAmount,
        uint256 refundReserve,
        uint256 creatorCommission,
        uint256 platformFee
    );
    event DisputeRaised(bytes32 indexed orderId, address indexed raisedBy);
    event DisputeResolved(
        bytes32 indexed orderId,
        uint256 toCustomer,
        uint256 toMerchant,
        uint256 toCreator,
        uint256 toPlatform
    );
    event ActualDutiesReported(
        bytes32 indexed orderId, uint256 estimatedDuties, uint256 actualDuties, bool anomalyFlagged
    );
    event AnomalyCleared(bytes32 indexed orderId, address indexed clearedBy);

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error OrderAlreadyExists();
    error OrderNotFound();
    error InvalidState();
    error SplitMismatch(uint256 sum, uint256 totalAmount);
    error ZeroAddress();
    error ZeroAmount();
    error RefundWindowNotElapsed(uint256 nowTs, uint256 releasableAt);
    error AnomalyFlaggedRelease();
    error NotFlagged();

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /// @param settlementToken The default ERC-20 used for settlement (USDC).
    /// @param admin Address granted all three roles for the demo. In prod, split these and use a multisig for ADMIN_ROLE.
    constructor(IERC20 settlementToken, address admin) {
        if (address(settlementToken) == address(0) || admin == address(0)) revert ZeroAddress();
        defaultToken = settlementToken;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MERCHANT_ROLE, admin);
        _grantRole(ORACLE_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Register an order and its four-bucket split. Bucket amounts must sum exactly to totalAmount.
    /// @dev MERCHANT_ROLE. Off-chain display fields (productName, customerCountry) are emitted, not stored.
    /// @param token Settlement token for this order. Pass address(0) to use `defaultToken` (USDC).
    function createOrder(
        bytes32 orderId,
        uint256 totalAmount,
        uint256 refundWindowSeconds,
        uint256 estimatedDuties,
        address token,
        Split calldata split,
        string calldata productName,
        string calldata customerCountry
    ) external onlyRole(MERCHANT_ROLE) {
        if (totalAmount == 0) revert ZeroAmount();
        if (_orders[orderId].totalAmount != 0) revert OrderAlreadyExists();
        if (
            split.merchant == address(0) || split.creator == address(0) || split.platform == address(0)
                || split.customer == address(0)
        ) revert ZeroAddress();

        uint256 sum = split.merchantAmount + split.refundReserve + split.creatorCommission + split.platformFee;
        if (sum != totalAmount) revert SplitMismatch(sum, totalAmount);

        address settlementToken = token == address(0) ? address(defaultToken) : token;

        _orders[orderId] = Order({
            totalAmount: totalAmount,
            deliveredAt: 0,
            refundWindowSeconds: refundWindowSeconds,
            estimatedDuties: estimatedDuties,
            actualDuties: 0,
            token: settlementToken,
            state: OrderState.Created,
            settled: false,
            anomalyFlagged: false,
            split: split
        });

        emit OrderCreated(
            orderId,
            totalAmount,
            refundWindowSeconds,
            estimatedDuties,
            settlementToken,
            split.merchant,
            split.creator,
            split.platform,
            split.customer,
            split.merchantAmount,
            split.refundReserve,
            split.creatorCommission,
            split.platformFee,
            productName,
            customerCountry
        );
    }

    /// @notice Customer funds the order, pulling totalAmount USDC into escrow.
    /// @dev Anyone may fund (typically the customer). Requires prior ERC-20 approval.
    function fundOrder(bytes32 orderId) external nonReentrant {
        Order storage order = _orders[orderId];
        if (order.totalAmount == 0) revert OrderNotFound();
        if (order.state != OrderState.Created) revert InvalidState();

        // Effects before interaction (CEI).
        order.state = OrderState.Funded;
        emit OrderFunded(orderId, msg.sender, order.totalAmount);

        IERC20(order.token).safeTransferFrom(msg.sender, address(this), order.totalAmount);
    }

    /// @notice Oracle reports the package was delivered, starting the refund window.
    function markDelivered(bytes32 orderId) external onlyRole(ORACLE_ROLE) {
        Order storage order = _orders[orderId];
        if (order.totalAmount == 0) revert OrderNotFound();
        if (order.state != OrderState.Funded) revert InvalidState();

        order.state = OrderState.Delivered;
        order.deliveredAt = block.timestamp;
        emit Delivered(orderId, block.timestamp);
    }

    /// @notice Oracle reports the duties actually charged at customs. If they exceed the
    ///         estimate by DUTIES_ANOMALY_MULTIPLE×, the order is auto-flagged and release blocks.
    /// @dev Only meaningful once delivered; only flags when an estimate was set.
    function reportActualDuties(bytes32 orderId, uint256 actualDuties) external onlyRole(ORACLE_ROLE) {
        Order storage order = _orders[orderId];
        if (order.totalAmount == 0) revert OrderNotFound();
        if (order.state != OrderState.Delivered) revert InvalidState();

        order.actualDuties = actualDuties;
        bool flagged = order.estimatedDuties > 0 && actualDuties > order.estimatedDuties * DUTIES_ANOMALY_MULTIPLE;
        if (flagged) order.anomalyFlagged = true;

        emit ActualDutiesReported(orderId, order.estimatedDuties, actualDuties, order.anomalyFlagged);
    }

    /// @notice Admin clears a duties anomaly after manual review, unblocking release.
    function clearAnomaly(bytes32 orderId) external onlyRole(ADMIN_ROLE) {
        Order storage order = _orders[orderId];
        if (order.totalAmount == 0) revert OrderNotFound();
        if (!order.anomalyFlagged) revert NotFlagged();

        order.anomalyFlagged = false;
        emit AnomalyCleared(orderId, msg.sender);
    }

    /// @notice After the refund window elapses, pay out all four buckets. Callable by anyone.
    function release(bytes32 orderId) external nonReentrant {
        Order storage order = _orders[orderId];
        if (order.totalAmount == 0) revert OrderNotFound();
        if (order.state != OrderState.Delivered) revert InvalidState();
        if (order.anomalyFlagged) revert AnomalyFlaggedRelease();

        uint256 releasableAt = order.deliveredAt + order.refundWindowSeconds;
        if (block.timestamp < releasableAt) revert RefundWindowNotElapsed(block.timestamp, releasableAt);

        Split memory s = order.split;
        address t = order.token;

        // Effects before interactions (CEI). settled guards re-entry / double release.
        order.state = OrderState.Released;
        order.settled = true;
        emit Released(orderId, s.merchantAmount, s.refundReserve, s.creatorCommission, s.platformFee);

        // The refund reserve is returned to the customer once the window passes without dispute.
        _payout(t, s.merchant, s.merchantAmount);
        _payout(t, s.customer, s.refundReserve);
        _payout(t, s.creator, s.creatorCommission);
        _payout(t, s.platform, s.platformFee);
    }

    /// @notice Open a dispute (package refused). Callable by the oracle or the customer.
    /// @dev Reachable from Funded or Delivered. Freezes the order until an admin resolves it.
    function raiseDispute(bytes32 orderId) external {
        Order storage order = _orders[orderId];
        if (order.totalAmount == 0) revert OrderNotFound();
        if (order.state != OrderState.Funded && order.state != OrderState.Delivered) revert InvalidState();
        if (!hasRole(ORACLE_ROLE, msg.sender) && msg.sender != order.split.customer) revert InvalidState();

        order.state = OrderState.Disputed;
        emit DisputeRaised(orderId, msg.sender);
    }

    /// @notice Admin resolves a dispute with an explicit four-way split. Payouts must sum exactly to totalAmount.
    /// @dev Value conservation: no minting, no trapped funds.
    function resolveDispute(
        bytes32 orderId,
        uint256 toCustomer,
        uint256 toMerchant,
        uint256 toCreator,
        uint256 toPlatform
    ) external onlyRole(ADMIN_ROLE) nonReentrant {
        Order storage order = _orders[orderId];
        if (order.totalAmount == 0) revert OrderNotFound();
        if (order.state != OrderState.Disputed) revert InvalidState();

        uint256 sum = toCustomer + toMerchant + toCreator + toPlatform;
        if (sum != order.totalAmount) revert SplitMismatch(sum, order.totalAmount);

        Split memory s = order.split;
        address t = order.token;

        // Effects before interactions (CEI).
        order.state = OrderState.Resolved;
        order.settled = true;
        emit DisputeResolved(orderId, toCustomer, toMerchant, toCreator, toPlatform);

        _payout(t, s.customer, toCustomer);
        _payout(t, s.merchant, toMerchant);
        _payout(t, s.creator, toCreator);
        _payout(t, s.platform, toPlatform);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Fetch an order. Reverts if it does not exist.
    function getOrder(bytes32 orderId) external view returns (Order memory) {
        Order memory order = _orders[orderId];
        if (order.totalAmount == 0) revert OrderNotFound();
        return order;
    }

    /// @notice Whether an order exists.
    function orderExists(bytes32 orderId) external view returns (bool) {
        return _orders[orderId].totalAmount != 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Skip zero-value transfers so a bucket set to 0 doesn't waste gas or revert on odd tokens.
    function _payout(address token, address to, uint256 amount) private {
        if (amount > 0) IERC20(token).safeTransfer(to, amount);
    }
}
