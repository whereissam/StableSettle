// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @dev A token that reverts transfers to a "blocked" address — models USDC's blacklist, used to
///      prove a hostile/blacklisted fee recipient cannot brick the agent's spend.
contract BlacklistToken is ERC20 {
    address public blocked;

    constructor() ERC20("Blacklist USD", "bUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address b) external {
        blocked = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(to != blocked, "blocked");
        super._update(from, to, value);
    }
}

contract AgentVaultTest is Test {
    AgentVault internal vault;
    MockUSDC internal usdc;

    // A $5,000 budget cap, in USDC's 6 decimals.
    uint256 internal constant CAP = 5_000e6;

    address internal human = makeAddr("human"); // human backer (owner)
    address internal agent = makeAddr("agent"); // the AI agent wallet
    address internal payee = makeAddr("payee"); // a recipient the agent pays
    address internal protocol = makeAddr("protocol"); // protocol fee recipient
    address internal payout = makeAddr("payout"); // the cold withdraw destination (distinct from human)
    address internal stranger = makeAddr("stranger");

    string internal constant ENS = "trader-bot.stablesettle.eth";
    bytes32 internal constant PROOF = keccak256("world-id-nullifier");

    function setUp() public {
        usdc = new MockUSDC();
        // Deploy with a cold payout address distinct from `human` so the withdraw-destination
        // invariant is actually exercised (funds can only ever land at `payout`).
        vault = new AgentVault(IERC20(address(usdc)), human, agent, CAP, ENS, PROOF, payout);

        // Human holds funds and approves the vault up front.
        usdc.mint(human, 1_000_000e6);
        vm.prank(human);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _fund(uint256 amount) internal {
        vm.prank(human);
        vault.fund(amount);
    }

    // ── constructor ─────────────────────────────────────────────────────────────

    function test_constructor_setsState() public view {
        assertEq(address(vault.token()), address(usdc));
        assertEq(vault.budgetCap(), CAP);
        assertEq(vault.spent(), 0);
        assertEq(vault.budgetRemaining(), CAP);
        assertTrue(vault.active());
        assertEq(vault.agentName(), ENS);
        assertEq(vault.humanProof(), PROOF);
        assertTrue(vault.hasRole(vault.HUMAN_OWNER_ROLE(), human));
        assertTrue(vault.hasRole(vault.AGENT_ROLE(), agent));
    }

    function test_constructor_rejectsZeroAddress() public {
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        new AgentVault(IERC20(address(0)), human, agent, CAP, ENS, PROOF, payout);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        new AgentVault(IERC20(address(usdc)), address(0), agent, CAP, ENS, PROOF, payout);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        new AgentVault(IERC20(address(usdc)), human, address(0), CAP, ENS, PROOF, payout);
    }

    function test_constructor_rejectsZeroCap() public {
        vm.expectRevert(AgentVault.ZeroAmount.selector);
        new AgentVault(IERC20(address(usdc)), human, agent, 0, ENS, PROOF, payout);
    }

    function test_constructor_setsOwnerPayout() public view {
        assertEq(vault.ownerPayout(), payout);
    }

    function test_constructor_ownerPayoutDefaultsToHumanWhenZero() public {
        AgentVault v = new AgentVault(IERC20(address(usdc)), human, agent, CAP, ENS, PROOF, address(0));
        assertEq(v.ownerPayout(), human);
    }

    // ── fund ──────────────────────────────────────────────────────────────────

    function test_fund_movesTokenIntoVault() public {
        _fund(1_000e6);
        assertEq(vault.balance(), 1_000e6);
        assertEq(usdc.balanceOf(address(vault)), 1_000e6);
    }

    function test_fund_rejectsZero() public {
        vm.prank(human);
        vm.expectRevert(AgentVault.ZeroAmount.selector);
        vault.fund(0);
    }

    // ── spend (the core: cap enforced in Solidity) ──────────────────────────────

    function test_spend_underCap_pays() public {
        _fund(CAP);

        vm.prank(agent);
        vault.spend(payee, 1_000e6);

        assertEq(usdc.balanceOf(payee), 1_000e6);
        assertEq(vault.spent(), 1_000e6);
        assertEq(vault.budgetRemaining(), CAP - 1_000e6);
    }

    function test_spend_accumulatesUpToCap() public {
        _fund(CAP);

        vm.startPrank(agent);
        vault.spend(payee, 3_000e6);
        vault.spend(payee, 2_000e6); // exactly hits the cap
        vm.stopPrank();

        assertEq(vault.spent(), CAP);
        assertEq(vault.budgetRemaining(), 0);
        assertEq(usdc.balanceOf(payee), CAP);
    }

    /// @notice THE headline guarantee: a spend over the remaining budget reverts.
    function test_spend_overCap_reverts() public {
        _fund(10_000e6); // vault is richly funded — only the cap should stop the agent

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.BudgetExceeded.selector, CAP + 1, CAP));
        vault.spend(payee, CAP + 1);
    }

    function test_spend_overCap_afterPartialSpend_reverts() public {
        _fund(10_000e6);

        vm.startPrank(agent);
        vault.spend(payee, 4_000e6); // remaining is now 1,000
        vm.expectRevert(abi.encodeWithSelector(AgentVault.BudgetExceeded.selector, 1_001e6, 1_000e6));
        vault.spend(payee, 1_001e6);
        vm.stopPrank();
    }

    function test_spend_underfundedVault_reverts() public {
        _fund(100e6); // under cap, but the vault simply doesn't hold enough

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.InsufficientBalance.selector, 500e6, 100e6));
        vault.spend(payee, 500e6);
    }

    function test_spend_onlyAgent() public {
        _fund(CAP);
        bytes32 role = vault.AGENT_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vault.spend(payee, 1e6);
    }

    function test_spend_rejectsZeroAddressAndAmount() public {
        _fund(CAP);
        vm.startPrank(agent);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        vault.spend(address(0), 1e6);
        vm.expectRevert(AgentVault.ZeroAmount.selector);
        vault.spend(payee, 0);
        vm.stopPrank();
    }

    // ── setCap ──────────────────────────────────────────────────────────────────

    function test_setCap_raise_allowsMoreSpend() public {
        _fund(20_000e6);

        vm.prank(agent);
        vault.spend(payee, CAP); // spend right up to the original cap

        vm.prank(human);
        vault.setCap(8_000e6);
        assertEq(vault.budgetRemaining(), 3_000e6);

        vm.prank(agent);
        vault.spend(payee, 3_000e6); // now possible
        assertEq(vault.spent(), 8_000e6);
    }

    function test_setCap_belowSpent_reverts() public {
        _fund(CAP);
        vm.prank(agent);
        vault.spend(payee, 2_000e6);

        vm.prank(human);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.CapBelowSpent.selector, 1_000e6, 2_000e6));
        vault.setCap(1_000e6);
    }

    function test_setCap_onlyHuman() public {
        bytes32 role = vault.HUMAN_OWNER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vault.setCap(1e6);
    }

    // ── daily limit (velocity guard) ────────────────────────────────────────────

    function test_dailyLimit_defaultsOff() public view {
        assertEq(vault.dailyLimit(), 0);
        assertEq(vault.dailyRemaining(), type(uint256).max);
    }

    // ── per-transaction cap (maxPerSpend) ──────────────────────────────────────

    function test_maxPerSpend_defaultsOff() public view {
        assertEq(vault.maxPerSpend(), 0);
    }

    function test_setMaxPerSpend_onlyHuman() public {
        bytes32 role = vault.HUMAN_OWNER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vault.setMaxPerSpend(100e6);
    }

    function test_maxPerSpend_atOrUnderLimit_pays() public {
        _fund(CAP);
        vm.prank(human);
        vault.setMaxPerSpend(100e6);

        vm.startPrank(agent);
        vault.spend(payee, 100e6); // exactly at the limit is allowed
        vault.spend(payee, 50e6);
        vm.stopPrank();

        assertEq(vault.spent(), 150e6);
        assertEq(usdc.balanceOf(payee), 150e6);
    }

    /// @notice A single spend over the per-tx limit reverts — even with the full lifetime budget free.
    function test_maxPerSpend_overLimit_reverts() public {
        _fund(CAP);
        vm.prank(human);
        vault.setMaxPerSpend(100e6);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.PerSpendLimitExceeded.selector, 100e6 + 1, 100e6));
        vault.spend(payee, 100e6 + 1);

        // The blocked spend changed nothing.
        assertEq(vault.spent(), 0);
        assertEq(usdc.balanceOf(payee), 0);
    }

    function test_maxPerSpend_canBeCleared() public {
        _fund(CAP);
        vm.startPrank(human);
        vault.setMaxPerSpend(100e6);
        vault.setMaxPerSpend(0); // 0 disables the per-tx limit again
        vm.stopPrank();

        vm.prank(agent);
        vault.spend(payee, 500e6); // now allowed — only the lifetime cap applies
        assertEq(vault.spent(), 500e6);
    }

    function test_setMaxPerSpend_emitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit AgentVault.MaxPerSpendChanged(0, 250e6);
        vm.prank(human);
        vault.setMaxPerSpend(250e6);
    }

    function test_setDailyLimit_onlyHuman() public {
        bytes32 role = vault.HUMAN_OWNER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vault.setDailyLimit(1_000e6);
    }

    function test_dailyLimit_underLimit_pays() public {
        _fund(CAP);
        vm.prank(human);
        vault.setDailyLimit(1_000e6);

        vm.prank(agent);
        vault.spend(payee, 600e6);

        assertEq(vault.spentLast24h(), 600e6);
        assertEq(vault.dailyRemaining(), 400e6);
        assertEq(usdc.balanceOf(payee), 600e6);
    }

    /// @notice Even with the full lifetime cap available, a burst over the daily limit reverts.
    function test_dailyLimit_overLimit_reverts() public {
        _fund(CAP);
        vm.prank(human);
        vault.setDailyLimit(1_000e6);

        vm.startPrank(agent);
        vault.spend(payee, 800e6); // remaining today: 200
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyLimitExceeded.selector, 300e6, 200e6));
        vault.spend(payee, 300e6);
        vm.stopPrank();

        // The lifetime cap is untouched by the blocked spend.
        assertEq(vault.spent(), 800e6);
        assertEq(vault.budgetRemaining(), CAP - 800e6);
    }

    function test_dailyLimit_resetsAfterWindow() public {
        _fund(CAP);
        vm.prank(human);
        vault.setDailyLimit(1_000e6);

        vm.prank(agent);
        vault.spend(payee, 1_000e6); // exhausts today's allowance
        assertEq(vault.dailyRemaining(), 0);

        // Still blocked within the window.
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyLimitExceeded.selector, 1e6, 0));
        vault.spend(payee, 1e6);

        // The window is rolling in whole hours: the spend frees up 24–25h after it was made.
        vm.warp(block.timestamp + 25 hours);
        assertEq(vault.dailyRemaining(), 1_000e6);
        vm.prank(agent);
        vault.spend(payee, 1_000e6);
        assertEq(vault.spentLast24h(), 1_000e6);
        assertEq(vault.spent(), 2_000e6); // lifetime spend still accumulates across windows
    }

    function test_setDailyLimit_toZero_disables() public {
        _fund(CAP);
        vm.startPrank(human);
        vault.setDailyLimit(100e6);
        vault.setDailyLimit(0); // clear it
        vm.stopPrank();

        vm.prank(agent);
        vault.spend(payee, 3_000e6); // far above the old daily limit, fine now
        assertEq(vault.spent(), 3_000e6);
        assertEq(vault.dailyRemaining(), type(uint256).max);
    }

    function test_dailyLimit_loweredBelowSpentToday_blocksUntilReset() public {
        _fund(CAP);
        vm.prank(human);
        vault.setDailyLimit(1_000e6);
        vm.prank(agent);
        vault.spend(payee, 900e6);

        // Human tightens the limit below what's already spent this window.
        vm.prank(human);
        vault.setDailyLimit(500e6);
        assertEq(vault.dailyRemaining(), 0); // no underflow, clamps to 0

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyLimitExceeded.selector, 1e6, 0));
        vault.spend(payee, 1e6);
    }

    // ── health() view ────────────────────────────────────────────────────────────

    function test_health_healthy() public {
        _fund(CAP);
        (uint8 status, uint256 capRemaining, uint256 todayRemaining) = vault.health();
        assertEq(status, 0);
        assertEq(capRemaining, CAP);
        assertEq(todayRemaining, type(uint256).max);
    }

    function test_health_warning_nearCap() public {
        _fund(CAP);
        vm.prank(agent);
        vault.spend(payee, 4_600e6); // 400 left of 5,000 → under 10%
        (uint8 status,,) = vault.health();
        assertEq(status, 1);
    }

    function test_health_warning_nearDailyLimit() public {
        _fund(CAP);
        vm.prank(human);
        vault.setDailyLimit(1_000e6);
        vm.prank(agent);
        vault.spend(payee, 950e6); // 50 left of 1,000 daily → under 10%
        (uint8 status,, uint256 todayRemaining) = vault.health();
        assertEq(status, 1);
        assertEq(todayRemaining, 50e6);
    }

    function test_health_frozen_whenRevoked() public {
        _fund(CAP);
        vm.prank(human);
        vault.revoke();
        (uint8 status,,) = vault.health();
        assertEq(status, 2);
    }

    // ── revoke / reinstate ───────────────────────────────────────────────────────

    function test_revoke_blocksSpend() public {
        _fund(CAP);

        vm.prank(human);
        vault.revoke();
        assertFalse(vault.active());

        vm.prank(agent);
        vm.expectRevert(AgentVault.AgentRevoked.selector);
        vault.spend(payee, 1e6);
    }

    function test_reinstate_restoresSpend() public {
        _fund(CAP);
        vm.prank(human);
        vault.revoke();

        vm.prank(human);
        vault.reinstate();
        assertTrue(vault.active());

        vm.prank(agent);
        vault.spend(payee, 1e6);
        assertEq(vault.spent(), 1e6);
    }

    function test_revoke_onlyHuman() public {
        bytes32 role = vault.HUMAN_OWNER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vault.revoke();
    }

    function test_revoke_twice_reverts() public {
        vm.startPrank(human);
        vault.revoke();
        vm.expectRevert(AgentVault.AgentRevoked.selector);
        vault.revoke();
        vm.stopPrank();
    }

    // ── withdraw ──────────────────────────────────────────────────────────────────

    function test_withdraw_sendsOnlyToOwnerPayout() public {
        _fund(CAP);
        // Even the human owner cannot name a destination — funds land at ownerPayout, never at `human`.
        vm.prank(human);
        vault.withdraw(2_000e6);
        assertEq(usdc.balanceOf(address(vault)), CAP - 2_000e6);
        assertEq(usdc.balanceOf(payout), 2_000e6, "funds must go to the cold payout address");
        // human funded the vault with CAP and received none of the withdrawal back.
        assertEq(usdc.balanceOf(human), 1_000_000e6 - CAP, "human must NOT receive the withdrawal");
    }

    function test_withdraw_moreThanBalance_reverts() public {
        _fund(100e6);
        vm.prank(human);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.InsufficientBalance.selector, 500e6, 100e6));
        vault.withdraw(500e6);
    }

    function test_withdraw_onlyHuman() public {
        _fund(CAP);
        bytes32 role = vault.HUMAN_OWNER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vault.withdraw(1e6);
    }

    /// @notice The core anti-theft guarantee: a fully compromised owner key cannot redirect funds.
    ///         Whoever holds HUMAN_OWNER_ROLE can only ever move money to the fixed cold address —
    ///         so a leaked key (or a withdraw triggered by a prompt-injected agent) drains to safety.
    function test_withdraw_compromisedOwnerKeyCannotRedirect() public {
        _fund(CAP);
        // The attacker has stolen the owner key and calls withdraw. There is no destination arg to
        // abuse: the funds still land at ownerPayout (the legitimate cold address), not anywhere else.
        vm.prank(human); // simulates the holder of the (stolen) owner key
        vault.withdraw(CAP);
        assertEq(usdc.balanceOf(payout), CAP, "withdrawal is forced home to ownerPayout");
        assertEq(usdc.balanceOf(stranger), 0, "attacker receives nothing");
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    // ── recipient allowlist ─────────────────────────────────────────────────────────

    function test_allowlist_defaultsOff() public {
        assertFalse(vault.allowlistEnabled());
        // With the allowlist off, the agent can pay anyone (subject only to the budget).
        _fund(CAP);
        vm.prank(agent);
        vault.spend(stranger, 100e6);
        assertEq(usdc.balanceOf(stranger), 100e6);
    }

    function test_allowlist_allowedRecipient_pays() public {
        _fund(CAP);
        vm.startPrank(human);
        vault.setAllowlistEnabled(true);
        vault.setAllowed(payee, true);
        vm.stopPrank();

        vm.prank(agent);
        vault.spend(payee, 100e6);
        assertEq(usdc.balanceOf(payee), 100e6);
    }

    function test_allowlist_notAllowed_reverts_evenUnderBudget() public {
        _fund(CAP);
        vm.prank(human);
        vault.setAllowlistEnabled(true);

        // Amount is tiny, budget is full, no daily limit — yet it reverts purely on the destination.
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.RecipientNotAllowed.selector, stranger));
        vault.spend(stranger, 1e6);
        assertEq(vault.spent(), 0, "a blocked spend must not move the budget");
    }

    function test_allowlist_agentCannotEdit() public {
        bytes32 ownerRole = vault.HUMAN_OWNER_ROLE();
        vm.startPrank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, agent, ownerRole)
        );
        vault.setAllowlistEnabled(true);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, agent, ownerRole)
        );
        vault.setAllowed(agent, true);
        vm.stopPrank();
    }

    function test_allowlist_toggleOff_restoresOpenSpend() public {
        _fund(CAP);
        vm.startPrank(human);
        vault.setAllowlistEnabled(true);
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.RecipientNotAllowed.selector, stranger));
        vault.spend(stranger, 1e6);

        vm.prank(human);
        vault.setAllowlistEnabled(false);
        vm.prank(agent);
        vault.spend(stranger, 1e6); // now allowed again
        assertEq(usdc.balanceOf(stranger), 1e6);
    }

    function test_allowlist_batch_setsMany() public {
        _fund(CAP);
        address other = makeAddr("other");
        address[] memory list = new address[](2);
        list[0] = payee;
        list[1] = other;
        vm.startPrank(human);
        vault.setAllowlistEnabled(true);
        vault.setAllowedBatch(list, true);
        vm.stopPrank();

        assertTrue(vault.allowedRecipients(payee));
        assertTrue(vault.allowedRecipients(other));
        vm.prank(agent);
        vault.spend(other, 50e6);
        assertEq(usdc.balanceOf(other), 50e6);
    }

    function test_setAllowed_rejectsZeroAddress() public {
        vm.prank(human);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        vault.setAllowed(address(0), true);
    }

    // ── per-recipient sub-budget ──────────────────────────────────────────────────

    function test_recipientCap_defaultsOff() public {
        // No per-recipient cap set → unlimited (only the lifetime cap applies).
        assertEq(vault.recipientCap(payee), 0);
        assertEq(vault.recipientRemaining(payee), type(uint256).max);
        _fund(CAP);
        vm.prank(agent);
        vault.spend(payee, 1_000e6); // far above any per-recipient cap, but none is set
        assertEq(usdc.balanceOf(payee), 1_000e6);
    }

    function test_recipientCap_underCap_pays() public {
        _fund(CAP);
        vm.prank(human);
        vault.setRecipientCap(payee, 100e6); // vendor 0xpayee ≤ $100

        vm.prank(agent);
        vault.spend(payee, 60e6);
        assertEq(usdc.balanceOf(payee), 60e6);
        assertEq(vault.recipientSpent(payee), 60e6);
        assertEq(vault.recipientRemaining(payee), 40e6);
    }

    function test_recipientCap_accumulatesUpToCap() public {
        _fund(CAP);
        vm.prank(human);
        vault.setRecipientCap(payee, 100e6);

        vm.startPrank(agent);
        vault.spend(payee, 60e6);
        vault.spend(payee, 40e6); // exactly hits the $100 cap
        vm.stopPrank();
        assertEq(vault.recipientSpent(payee), 100e6);
        assertEq(vault.recipientRemaining(payee), 0);
    }

    function test_recipientCap_overCap_reverts_evenUnderBudget() public {
        _fund(CAP);
        vm.prank(human);
        vault.setRecipientCap(payee, 100e6);

        vm.startPrank(agent);
        vault.spend(payee, 80e6);
        // Lifetime budget is barely touched, but THIS recipient has $20 left → a $30 spend reverts.
        vm.expectRevert(abi.encodeWithSelector(AgentVault.RecipientCapExceeded.selector, payee, 30e6, 20e6));
        vault.spend(payee, 30e6);
        vm.stopPrank();
        assertEq(vault.recipientSpent(payee), 80e6, "a blocked spend must not move the recipient tally");
        assertEq(vault.spent(), 80e6, "a blocked spend must not move the budget");
    }

    function test_recipientCap_isPerRecipient_notGlobal() public {
        _fund(CAP);
        address other = makeAddr("otherVendor");
        vm.startPrank(human);
        vault.setRecipientCap(payee, 50e6);
        vault.setRecipientCap(other, 50e6);
        vm.stopPrank();

        vm.startPrank(agent);
        vault.spend(payee, 50e6); // payee's cap exhausted
        vault.spend(other, 50e6); // other still has its own full cap
        vm.expectRevert(abi.encodeWithSelector(AgentVault.RecipientCapExceeded.selector, payee, 1e6, 0));
        vault.spend(payee, 1e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(payee), 50e6);
        assertEq(usdc.balanceOf(other), 50e6);
    }

    function test_recipientCap_uncappedRecipientUnaffected() public {
        // A cap on `payee` must not constrain or record spend to a different, uncapped recipient.
        _fund(CAP);
        vm.prank(human);
        vault.setRecipientCap(payee, 10e6);

        vm.prank(agent);
        vault.spend(stranger, 1_000e6); // uncapped → only the lifetime budget applies
        assertEq(usdc.balanceOf(stranger), 1_000e6);
        assertEq(vault.recipientSpent(stranger), 0, "uncapped recipients accrue no per-recipient tally");
    }

    function test_recipientCap_worksWithAllowlistOn() public {
        // The intended combo: allowlist gates WHO, per-recipient cap gates HOW MUCH each one gets.
        _fund(CAP);
        vm.startPrank(human);
        vault.setAllowlistEnabled(true);
        vault.setAllowedWithCap(payee, true, 100e6);
        vm.stopPrank();

        assertTrue(vault.allowedRecipients(payee));
        assertEq(vault.recipientCap(payee), 100e6);

        vm.startPrank(agent);
        vault.spend(payee, 100e6);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.RecipientCapExceeded.selector, payee, 1e6, 0));
        vault.spend(payee, 1e6);
        vm.stopPrank();
    }

    function test_recipientCap_canBeRaised() public {
        _fund(CAP);
        vm.prank(human);
        vault.setRecipientCap(payee, 50e6);
        vm.prank(agent);
        vault.spend(payee, 50e6); // exhausts the cap

        vm.prank(human);
        vault.setRecipientCap(payee, 80e6); // raise it
        assertEq(vault.recipientRemaining(payee), 30e6);
        vm.prank(agent);
        vault.spend(payee, 30e6);
        assertEq(vault.recipientSpent(payee), 80e6);
    }

    function test_recipientCap_clearedWithZero() public {
        _fund(CAP);
        vm.prank(human);
        vault.setRecipientCap(payee, 50e6);
        vm.prank(agent);
        vault.spend(payee, 50e6); // exhausts the cap

        // Clearing the cap (0) removes the per-recipient ceiling entirely.
        vm.prank(human);
        vault.setRecipientCap(payee, 0);
        assertEq(vault.recipientRemaining(payee), type(uint256).max);
        vm.prank(agent);
        vault.spend(payee, 1_000e6); // now bounded only by the lifetime budget
        assertEq(usdc.balanceOf(payee), 1_050e6);
    }

    function test_setRecipientCap_onlyHuman() public {
        bytes32 ownerRole = vault.HUMAN_OWNER_ROLE();
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, agent, ownerRole)
        );
        vault.setRecipientCap(payee, 100e6);
    }

    function test_setRecipientCap_rejectsZeroAddress() public {
        vm.prank(human);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        vault.setRecipientCap(address(0), 100e6);
    }

    function test_setRecipientCap_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit AgentVault.RecipientCapChanged(payee, 100e6);
        vm.prank(human);
        vault.setRecipientCap(payee, 100e6);
    }

    function test_setAllowedWithCap_setsBoth() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit AgentVault.RecipientAllowedChanged(payee, true);
        vm.expectEmit(true, false, false, true, address(vault));
        emit AgentVault.RecipientCapChanged(payee, 100e6);
        vm.prank(human);
        vault.setAllowedWithCap(payee, true, 100e6);
        assertTrue(vault.allowedRecipients(payee));
        assertEq(vault.recipientCap(payee), 100e6);
    }

    function test_setAllowedWithCap_onlyHuman() public {
        bytes32 ownerRole = vault.HUMAN_OWNER_ROLE();
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, agent, ownerRole)
        );
        vault.setAllowedWithCap(payee, true, 100e6);
    }

    // ── protocol fee ──────────────────────────────────────────────────────────────
    // This test contract deployed the vault, so it holds FEE_ADMIN_ROLE (the "protocol").

    function test_fee_defaultsOff() public view {
        assertEq(vault.feeBps(), 0);
        assertEq(vault.feeRecipient(), address(0));
    }

    function test_setFee_thenSpend_takesValueConservingFee() public {
        vault.setFee(50, protocol); // 0.5%
        _fund(CAP);

        vm.prank(agent);
        vault.spend(payee, 1_000e6);

        // 0.5% of 1,000 = 5 to protocol, 995 to payee, and the full 1,000 counts against the budget.
        assertEq(usdc.balanceOf(protocol), 5e6);
        assertEq(usdc.balanceOf(payee), 995e6);
        assertEq(vault.spent(), 1_000e6);
        assertEq(vault.budgetRemaining(), CAP - 1_000e6);
    }

    function test_setFee_rejectsAboveMax() public {
        vm.expectRevert(abi.encodeWithSelector(AgentVault.FeeTooHigh.selector, 101, vault.MAX_FEE_BPS()));
        vault.setFee(101, protocol);
    }

    function test_setFee_rejectsZeroRecipientWhenNonZeroFee() public {
        vm.expectRevert(AgentVault.FeeRecipientZero.selector);
        vault.setFee(50, address(0));
    }

    function test_setFee_onlyFeeAdmin_notHuman() public {
        bytes32 role = vault.FEE_ADMIN_ROLE();
        // The human owner is DEFAULT_ADMIN but is NOT a fee admin.
        vm.prank(human);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, human, role));
        vault.setFee(50, protocol);
    }

    function test_human_canRevokeFeeAdmin_forLiveness() public {
        // DEFAULT_ADMIN (human) manages FEE_ADMIN_ROLE, so it can revoke a misbehaving fee admin —
        // the human is never locked out of their own vault.
        bytes32 feeRole = vault.FEE_ADMIN_ROLE();
        assertTrue(vault.hasRole(feeRole, address(this)));

        vm.prank(human);
        vault.revokeRole(feeRole, address(this));
        assertFalse(vault.hasRole(feeRole, address(this)));

        // The former fee admin can no longer change the fee.
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), feeRole)
        );
        vault.setFee(50, protocol);
    }

    function test_spend_doesNotBrickWhenFeeRecipientReverts() public {
        // A hostile/blacklisted fee recipient must never freeze the agent's core function.
        BlacklistToken bt = new BlacklistToken();
        AgentVault v = new AgentVault(IERC20(address(bt)), human, agent, CAP, ENS, PROOF, payout);
        bt.mint(human, 1_000_000e6);
        vm.prank(human);
        bt.approve(address(v), type(uint256).max);

        v.setFee(50, protocol); // this contract is the deployer → fee admin
        bt.setBlocked(protocol); // the protocol can no longer receive the token

        vm.prank(human);
        v.fund(CAP);

        vm.prank(agent);
        v.spend(payee, 1_000e6); // must NOT revert despite the fee transfer failing

        // Fee skipped → payee gets the full amount, protocol gets nothing, budget still counts the spend.
        assertEq(bt.balanceOf(payee), 1_000e6);
        assertEq(bt.balanceOf(protocol), 0);
        assertEq(v.spent(), 1_000e6);
    }

    // ── security review regressions (2026-11-03) ──────────────────────────────────

    /// A stolen owner key must not be able to make itself the agent and drain the vault.
    function test_ownerCannotGrantAgentRole() public {
        _fund(CAP);
        bytes32 role = vault.AGENT_ROLE();
        vm.prank(human);
        vm.expectRevert(AgentVault.AgentImmutable.selector);
        vault.grantRole(role, stranger);
        assertFalse(vault.hasRole(role, stranger));
    }

    /// Other roles are still grantable by the admin (the fee-admin liveness escape keeps working).
    function test_ownerCanStillGrantOtherRoles() public {
        bytes32 role = vault.FEE_ADMIN_ROLE();
        vm.prank(human);
        vault.grantRole(role, stranger);
        assertTrue(vault.hasRole(role, stranger));
    }

    /// Spending a full allowance at the end of one 24h stretch and again right after must revert —
    /// the old fixed window allowed ~2x the limit within seconds.
    function test_dailyLimit_isRolling_noBoundaryBurst() public {
        _fund(CAP);
        vm.prank(human);
        vault.setDailyLimit(100e6);
        vm.warp(1_000_000);
        vm.prank(agent);
        vault.spend(payee, 1);
        vm.warp(1_000_000 + 1 days - 1);
        vm.prank(agent);
        vault.spend(payee, 100e6 - 1);
        vm.warp(1_000_000 + 1 days);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyLimitExceeded.selector, 100e6, 0));
        vault.spend(payee, 100e6);
    }

    /// Allowance frees up hour by hour as old spends age out, not all at once.
    function test_dailyLimit_freesUpGradually() public {
        _fund(CAP);
        vm.prank(human);
        vault.setDailyLimit(100e6);
        uint256 t0 = 1_000_000 * 3600; // an hour boundary
        vm.warp(t0);
        vm.prank(agent);
        vault.spend(payee, 40e6);
        vm.warp(t0 + 10 hours);
        vm.prank(agent);
        vault.spend(payee, 60e6);
        assertEq(vault.dailyRemaining(), 0);
        vm.warp(t0 + 25 hours); // first spend is now 25h old, second 15h old
        assertEq(vault.dailyRemaining(), 40e6);
        vm.warp(t0 + 35 hours); // both aged out
        assertEq(vault.dailyRemaining(), 100e6);
    }

    /// Fuzz: no sequence of spends puts more than dailyLimit into any 24h window.
    function testFuzz_dailyLimit_neverExceededInAny24h(uint32[8] memory gaps, uint64[8] memory amounts) public {
        _fund(CAP);
        uint256 limit = 100e6;
        vm.prank(human);
        vault.setDailyLimit(limit);
        uint256[8] memory ts;
        uint256[8] memory paid;
        uint256 t = 1_000_000;
        for (uint256 i = 0; i < 8; i++) {
            t += uint256(gaps[i]) % 2 days;
            vm.warp(t);
            uint256 amt = bound(amounts[i], 1, limit);
            vm.prank(agent);
            try vault.spend(payee, amt) {
                paid[i] = amt;
            } catch {}
            ts[i] = t;
        }
        for (uint256 i = 0; i < 8; i++) {
            uint256 sum;
            for (uint256 j = i; j < 8 && ts[j] < ts[i] + 1 days; j++) sum += paid[j];
            assertLe(sum, limit);
        }
    }
}
