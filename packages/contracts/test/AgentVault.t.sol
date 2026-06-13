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
    address internal stranger = makeAddr("stranger");

    string internal constant ENS = "trader-bot.stablesettle.eth";
    bytes32 internal constant PROOF = keccak256("world-id-nullifier");

    function setUp() public {
        usdc = new MockUSDC();
        vault = new AgentVault(IERC20(address(usdc)), human, agent, CAP, ENS, PROOF);

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
        new AgentVault(IERC20(address(0)), human, agent, CAP, ENS, PROOF);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        new AgentVault(IERC20(address(usdc)), address(0), agent, CAP, ENS, PROOF);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        new AgentVault(IERC20(address(usdc)), human, address(0), CAP, ENS, PROOF);
    }

    function test_constructor_rejectsZeroCap() public {
        vm.expectRevert(AgentVault.ZeroAmount.selector);
        new AgentVault(IERC20(address(usdc)), human, agent, 0, ENS, PROOF);
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

        assertEq(vault.spentToday(), 600e6);
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

        // After 24h the window rolls and the full daily allowance is available again.
        vm.warp(block.timestamp + 1 days);
        assertEq(vault.dailyRemaining(), 1_000e6);
        vm.prank(agent);
        vault.spend(payee, 1_000e6);
        assertEq(vault.spentToday(), 1_000e6);
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

    function test_withdraw_returnsFundsToHuman() public {
        _fund(CAP);
        vm.prank(human);
        vault.withdraw(human, 2_000e6);
        assertEq(usdc.balanceOf(address(vault)), CAP - 2_000e6);
    }

    function test_withdraw_moreThanBalance_reverts() public {
        _fund(100e6);
        vm.prank(human);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.InsufficientBalance.selector, 500e6, 100e6));
        vault.withdraw(human, 500e6);
    }

    function test_withdraw_onlyHuman() public {
        _fund(CAP);
        bytes32 role = vault.HUMAN_OWNER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        vault.withdraw(stranger, 1e6);
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
        AgentVault v = new AgentVault(IERC20(address(bt)), human, agent, CAP, ENS, PROOF);
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
}
