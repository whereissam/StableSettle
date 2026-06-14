// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title AgentVault
/// @notice A budget-capped treasury for a single AI agent. A human owner funds it and sets a
///         spend cap; the agent may pay anyone, but only up to that cap. The cap is enforced in
///         Solidity — an over-budget `spend` *reverts*, it is not merely flagged. The human can
///         raise or lower the cap, revoke the agent, and withdraw the remaining balance at any time.
/// @dev Holds an ERC-20 settlement token (point it at Arc's native USDC, 0x3600...0000, 6 decimals,
///      for production, or at MockUSDC for a self-contained demo). One vault is deployed per agent
///      by `arc:spawn-agent`. The agent's ENS name and the human's World ID nullifier are recorded
///      on-chain at construction as provenance for the "human-backed, compliant agent" claim — the
///      verification itself happens off-chain in the spawn flow; this is the on-chain evidence of it.
contract AgentVault is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Roles
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The human backer. May fund, change the cap, revoke the agent, and withdraw.
    ///         In production this should be a multisig.
    bytes32 public constant HUMAN_OWNER_ROLE = keccak256("HUMAN_OWNER_ROLE");
    /// @notice The AI agent. May `spend` up to the remaining budget while not revoked.
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    /// @notice The protocol. May set the spend fee. Managed by DEFAULT_ADMIN_ROLE (the human),
    ///         who therefore keeps a liveness escape — they can revoke a misbehaving fee admin
    ///         rather than being locked out of their own vault. The fee is cooperative, not
    ///         adversarially enforced: it's the user's vault, so the user can always protect it.
    bytes32 public constant FEE_ADMIN_ROLE = keccak256("FEE_ADMIN_ROLE");

    /// @notice The spend fee can never exceed 1% — it can shave the protocol's cut, never rug the agent.
    uint256 public constant MAX_FEE_BPS = 100;

    /// @notice The rolling window for the optional daily velocity limit.
    uint256 public constant DAY = 1 days;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The settlement token the agent spends (USDC).
    IERC20 public immutable token;

    /// @notice Lifetime spend ceiling, in token units. The agent's cumulative `spent` may never exceed this.
    uint256 public budgetCap;
    /// @notice Cumulative amount the agent has spent. Monotonically increasing.
    uint256 public spent;
    /// @notice False once the human revokes the agent. A revoked agent cannot spend.
    bool public active;

    /// @notice The agent's ENS name (e.g. "trader-bot.stablesettle.eth"). Provenance only.
    string public agentName;
    /// @notice The World ID nullifier hash of the human who authorized this agent. Provenance only.
    bytes32 public humanProof;

    /// @notice The ONLY address `withdraw` can send funds to — fixed at construction, immutable.
    ///         This is the anti-theft invariant: even if the HUMAN_OWNER_ROLE key is fully
    ///         compromised (or a `withdraw` tool is exposed to a prompt-injected agent), recovered
    ///         funds can only ever go *home* to this address — never to an attacker-chosen one.
    ///         Withdraw therefore has no arbitrary destination at all. Set it to a cold address
    ///         distinct from the hot operating key to neutralise a key leak entirely.
    address public immutable ownerPayout;

    /// @notice Protocol fee on each spend, in basis points (0 = off). Capped at MAX_FEE_BPS.
    uint256 public feeBps;
    /// @notice Where the protocol fee is sent. address(0) means no fee is taken.
    address public feeRecipient;

    /// @notice Optional per-transaction ceiling, in token units. 0 = disabled. A single `spend` may never
    ///         exceed this — an item-level cap on top of the lifetime budget and the daily velocity limit.
    ///         Enforced in `spend` (reverts), not flagged. Lets an owner say "this agent buys, but no single
    ///         purchase over $X" regardless of how much budget remains.
    uint256 public maxPerSpend;

    /// @notice Optional rolling 24h spend ceiling, in token units. 0 = disabled (only the lifetime cap applies).
    ///         A velocity guard: even with budget left under the lifetime cap, the agent cannot burst more than
    ///         this within any 24h window — so a hijacked agent can't drain a year's budget in one minute.
    ///         Like the lifetime cap, it's enforced in `spend` (reverts), not flagged.
    uint256 public dailyLimit;
    /// @notice Start of the current 24h window. Rolls forward to the spend that opens a fresh window.
    uint256 public windowStart;
    /// @notice Amount spent within the current window. Logically resets once the window elapses.
    uint256 public spentToday;

    /// @notice When true, the agent may only pay addresses on `allowedRecipients`. Default false (off),
    ///         so existing behaviour is unchanged until an owner opts in. This is the defence against a
    ///         prompt-injected/hijacked agent being talked into paying an *attacker* within budget: the
    ///         amount, the budget, and the daily limit can all be fine, yet the spend still reverts
    ///         because the destination isn't approved. Enforced in `spend`, not flagged off-chain.
    bool public allowlistEnabled;
    /// @notice Addresses the agent is permitted to pay when `allowlistEnabled` is true. Owner-managed.
    mapping(address => bool) public allowedRecipients;

    // ─────────────────────────────────────────────────────────────────────────
    // Events — an off-chain audit log / deployment card is built entirely from these.
    // ─────────────────────────────────────────────────────────────────────────

    event VaultDeployed(
        address indexed human,
        address indexed agent,
        address token,
        uint256 budgetCap,
        string agentName,
        bytes32 humanProof
    );
    event Funded(address indexed from, uint256 amount);
    event Spent(address indexed agent, address indexed to, uint256 amount, uint256 spentTotal, uint256 remaining);
    event SpendFeeTaken(address indexed recipient, uint256 fee);
    event FeeChanged(uint256 feeBps, address recipient);
    event CapChanged(uint256 oldCap, uint256 newCap);
    event MaxPerSpendChanged(uint256 oldLimit, uint256 newLimit);
    event DailyLimitChanged(uint256 oldLimit, uint256 newLimit);
    event AllowlistEnabledChanged(bool enabled);
    event RecipientAllowedChanged(address indexed recipient, bool allowed);
    event Revoked(address indexed by);
    event Reinstated(address indexed by);
    event Withdrawn(address indexed to, uint256 amount);

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    /// @notice The agent tried to spend more than its remaining budget. This is the budget cap doing its job.
    error BudgetExceeded(uint256 requested, uint256 remaining);
    /// @notice The agent tried to spend more than the per-transaction limit in a single `spend`.
    error PerSpendLimitExceeded(uint256 requested, uint256 limit);
    /// @notice The agent tried to spend more than its remaining allowance for the current 24h window.
    error DailyLimitExceeded(uint256 requested, uint256 remainingToday);
    /// @notice The allowlist is on and the agent tried to pay an address that isn't approved. The spend
    ///         is refused regardless of budget — a hijacked agent can't be talked into paying a stranger.
    error RecipientNotAllowed(address recipient);
    /// @notice A new cap cannot be set below what the agent has already spent.
    error CapBelowSpent(uint256 newCap, uint256 spent);
    error AgentRevoked();
    error AgentActive();
    /// @notice The requested fee exceeds MAX_FEE_BPS.
    error FeeTooHigh(uint256 requested, uint256 max);
    /// @notice A non-zero fee requires a non-zero recipient.
    error FeeRecipientZero();
    /// @notice The vault does not hold enough token to cover the transfer.
    error InsufficientBalance(uint256 requested, uint256 balance);

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /// @param settlementToken The ERC-20 the agent spends (USDC).
    /// @param human The human backer. Granted DEFAULT_ADMIN_ROLE + HUMAN_OWNER_ROLE.
    /// @param agent The AI agent's wallet. Granted AGENT_ROLE.
    /// @param cap The lifetime spend ceiling, in token units (e.g. 5000e6 for 5,000 USDC).
    /// @param name The agent's ENS name, recorded as provenance.
    /// @param proof The human's World ID nullifier hash, recorded as provenance (0 if not used).
    /// @param payout The sole address `withdraw` may send to (a cold recovery address). If zero,
    ///        it defaults to `human` — never to an attacker-supplied value, and never settable later.
    constructor(
        IERC20 settlementToken,
        address human,
        address agent,
        uint256 cap,
        string memory name,
        bytes32 proof,
        address payout
    ) {
        if (address(settlementToken) == address(0) || human == address(0) || agent == address(0)) {
            revert ZeroAddress();
        }
        if (cap == 0) revert ZeroAmount();

        token = settlementToken;
        budgetCap = cap;
        active = true;
        agentName = name;
        humanProof = proof;
        // The withdraw destination is locked here for the life of the vault. Defaulting to `human`
        // keeps the safe behaviour for callers that don't separate a cold address; a distinct cold
        // `payout` makes even a stolen owner key unable to redirect a withdrawal.
        ownerPayout = payout == address(0) ? human : payout;

        _grantRole(DEFAULT_ADMIN_ROLE, human);
        _grantRole(HUMAN_OWNER_ROLE, human);
        _grantRole(AGENT_ROLE, agent);

        // The deployer (protocol operator) gets the fee role initially. DEFAULT_ADMIN_ROLE (the human)
        // is its admin, so the human can revoke or reassign it — a liveness safeguard so a misbehaving
        // fee admin can never permanently brick the user's own vault.
        _setRoleAdmin(FEE_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        _grantRole(FEE_ADMIN_ROLE, msg.sender);

        emit VaultDeployed(human, agent, address(settlementToken), cap, name, proof);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Agent
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The agent pays `to` `amount` of token. Reverts if it would push cumulative spend
    ///         over the budget cap, if the agent is revoked, or if the vault is underfunded.
    /// @dev AGENT_ROLE. CEI: spend is recorded before the transfer; nonReentrant for defence in depth.
    function spend(address to, uint256 amount) external onlyRole(AGENT_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!active) revert AgentRevoked();

        // Recipient allowlist: when on, the destination must be pre-approved by the owner. Checked up
        // front so a prompt-injected agent paying a stranger reverts even when the amount is well within
        // budget. The agent (AGENT_ROLE) can never edit this list — only HUMAN_OWNER_ROLE can.
        if (allowlistEnabled && !allowedRecipients[to]) revert RecipientNotAllowed(to);

        // Per-transaction cap: an item-level ceiling. 0 = disabled. Checked first so a single oversized
        // spend reverts with the specific error, regardless of remaining budget.
        if (maxPerSpend > 0 && amount > maxPerSpend) revert PerSpendLimitExceeded(amount, maxPerSpend);

        uint256 remaining = budgetCap - spent;
        if (amount > remaining) revert BudgetExceeded(amount, remaining);

        // Velocity guard: an optional rolling 24h limit on top of the lifetime cap. 0 = disabled.
        // Even with budget left under the cap, the agent can't burst more than `dailyLimit` per window.
        if (dailyLimit > 0) {
            // A window that has elapsed is treated as empty without needing a prior write.
            uint256 usedToday = block.timestamp >= windowStart + DAY ? 0 : spentToday;
            uint256 remainingToday = usedToday >= dailyLimit ? 0 : dailyLimit - usedToday;
            if (amount > remainingToday) revert DailyLimitExceeded(amount, remainingToday);
            // Open a fresh window on the first spend after it elapsed (CEI: effects before transfer).
            if (usedToday == 0) windowStart = block.timestamp;
            spentToday = usedToday + amount;
        }

        uint256 bal = token.balanceOf(address(this));
        if (amount > bal) revert InsufficientBalance(amount, bal);

        // Effects before interaction (CEI).
        uint256 newSpent = spent + amount;
        spent = newSpent;

        // Value-conserving protocol fee: the recipient nets `amount - fee`, the protocol gets `fee`,
        // and the full `amount` counts against the budget. Fee is 0 unless a FEE_ADMIN enabled it.
        address recipient = feeRecipient;
        uint256 fee = (recipient != address(0) && feeBps > 0) ? (amount * feeBps) / 10_000 : 0;

        if (fee > 0) {
            // Fee collection must NEVER block the agent's core function. If the recipient rejects the
            // transfer (e.g. it lands on a USDC blacklist), skip the fee — the payee gets the full
            // amount and the spend still succeeds. Otherwise a hostile/blacklisted fee recipient could
            // brick every spend. spent already counts the full amount, so value is still conserved.
            try token.transfer(recipient, fee) returns (bool ok) {
                if (ok) emit SpendFeeTaken(recipient, fee);
                else fee = 0;
            } catch {
                fee = 0;
            }
        }

        emit Spent(msg.sender, to, amount, newSpent, budgetCap - newSpent);
        token.safeTransfer(to, amount - fee);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Protocol fee
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Set the per-spend protocol fee. FEE_ADMIN_ROLE only (the protocol, not the human owner).
    /// @param newFeeBps Fee in basis points, capped at MAX_FEE_BPS. 0 disables the fee.
    /// @param recipient Where the fee is sent. Must be non-zero when newFeeBps > 0.
    function setFee(uint256 newFeeBps, address recipient) external onlyRole(FEE_ADMIN_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        if (newFeeBps > 0 && recipient == address(0)) revert FeeRecipientZero();
        feeBps = newFeeBps;
        feeRecipient = recipient;
        emit FeeChanged(newFeeBps, recipient);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Human owner
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Top the vault up with `amount` token. Requires prior ERC-20 approval. Anyone may fund.
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        emit Funded(msg.sender, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Change the agent's lifetime spend cap. Cannot be set below what's already spent.
    function setCap(uint256 newCap) external onlyRole(HUMAN_OWNER_ROLE) {
        if (newCap == 0) revert ZeroAmount();
        if (newCap < spent) revert CapBelowSpent(newCap, spent);
        uint256 oldCap = budgetCap;
        budgetCap = newCap;
        emit CapChanged(oldCap, newCap);
    }

    /// @notice Set (or clear, with 0) the per-transaction spend ceiling. HUMAN_OWNER_ROLE.
    /// @dev Applies to future spends only; never reverts a past one. 0 removes the per-spend limit.
    function setMaxPerSpend(uint256 newLimit) external onlyRole(HUMAN_OWNER_ROLE) {
        uint256 oldLimit = maxPerSpend;
        maxPerSpend = newLimit;
        emit MaxPerSpendChanged(oldLimit, newLimit);
    }

    /// @notice Set (or clear, with 0) the rolling 24h spend limit. HUMAN_OWNER_ROLE.
    /// @dev Tightening below what's already spent this window simply blocks further spends until the
    ///      window rolls — it never reverts retroactively. 0 removes the daily limit entirely.
    function setDailyLimit(uint256 newLimit) external onlyRole(HUMAN_OWNER_ROLE) {
        uint256 oldLimit = dailyLimit;
        dailyLimit = newLimit;
        emit DailyLimitChanged(oldLimit, newLimit);
    }

    /// @notice Turn the recipient allowlist on or off. HUMAN_OWNER_ROLE only. When on, the agent may
    ///         only pay approved addresses. Off (default) keeps the original behaviour.
    function setAllowlistEnabled(bool enabled) external onlyRole(HUMAN_OWNER_ROLE) {
        allowlistEnabled = enabled;
        emit AllowlistEnabledChanged(enabled);
    }

    /// @notice Approve or un-approve a single recipient. HUMAN_OWNER_ROLE only — never the agent, so a
    ///         hijacked agent cannot whitelist its own attacker. Applies whenever the allowlist is on.
    function setAllowed(address recipient, bool allowed) external onlyRole(HUMAN_OWNER_ROLE) {
        if (recipient == address(0)) revert ZeroAddress();
        allowedRecipients[recipient] = allowed;
        emit RecipientAllowedChanged(recipient, allowed);
    }

    /// @notice Approve or un-approve many recipients in one call. HUMAN_OWNER_ROLE only.
    function setAllowedBatch(address[] calldata recipients, bool allowed) external onlyRole(HUMAN_OWNER_ROLE) {
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == address(0)) revert ZeroAddress();
            allowedRecipients[recipients[i]] = allowed;
            emit RecipientAllowedChanged(recipients[i], allowed);
        }
    }

    /// @notice Revoke the agent — it can no longer spend. Funds stay in the vault for withdrawal.
    function revoke() external onlyRole(HUMAN_OWNER_ROLE) {
        if (!active) revert AgentRevoked();
        active = false;
        emit Revoked(msg.sender);
    }

    /// @notice Re-enable a previously revoked agent.
    function reinstate() external onlyRole(HUMAN_OWNER_ROLE) {
        if (active) revert AgentActive();
        active = true;
        emit Reinstated(msg.sender);
    }

    /// @notice Withdraw `amount` token from the vault. The human's escape hatch. There is NO
    ///         destination parameter by design: funds can only ever return to `ownerPayout`, the
    ///         address fixed at construction. So even a stolen HUMAN_OWNER_ROLE key (or a withdraw
    ///         call triggered by a prompt-injected agent) can move money home — never to an attacker.
    function withdraw(uint256 amount) external onlyRole(HUMAN_OWNER_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = token.balanceOf(address(this));
        if (amount > bal) revert InsufficientBalance(amount, bal);
        emit Withdrawn(ownerPayout, amount);
        token.safeTransfer(ownerPayout, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Token still spendable under the cap (does not account for the vault's actual balance).
    function budgetRemaining() external view returns (uint256) {
        return budgetCap - spent;
    }

    /// @notice Token still spendable in the current 24h window. type(uint256).max when no daily limit is set.
    function dailyRemaining() public view returns (uint256) {
        if (dailyLimit == 0) return type(uint256).max;
        uint256 usedToday = block.timestamp >= windowStart + DAY ? 0 : spentToday;
        return usedToday >= dailyLimit ? 0 : dailyLimit - usedToday;
    }

    /// @notice A compact on-chain health signal for dashboards and monitors — readable by anyone, no backend.
    /// @return status 0 = healthy, 1 = warning (lifetime cap or daily allowance nearly exhausted), 2 = frozen (agent revoked).
    /// @return capRemaining Token still spendable under the lifetime cap.
    /// @return todayRemaining Token still spendable in the current 24h window (max when no daily limit).
    function health() external view returns (uint8 status, uint256 capRemaining, uint256 todayRemaining) {
        capRemaining = budgetCap - spent;
        todayRemaining = dailyRemaining();
        if (!active) return (2, capRemaining, todayRemaining);
        // Warning under 10% of the lifetime cap, or under 10% of the daily limit when one is set.
        bool capLow = capRemaining * 10 < budgetCap;
        bool dayLow = dailyLimit > 0 && todayRemaining * 10 < dailyLimit;
        status = (capLow || dayLow) ? 1 : 0;
    }

    /// @notice The vault's current token balance.
    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
