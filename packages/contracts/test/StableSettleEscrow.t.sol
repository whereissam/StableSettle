// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StableSettleEscrow} from "../src/StableSettleEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockEURC} from "../src/MockEURC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract StableSettleEscrowTest is Test {
    StableSettleEscrow internal escrow;
    MockUSDC internal usdc;

    // The demo $100 order, in USDC's 6 decimals.
    uint256 internal constant TOTAL = 100e6;
    uint256 internal constant MERCHANT_AMT = 85e6;
    uint256 internal constant REFUND_RESERVE = 8e6;
    uint256 internal constant CREATOR_AMT = 5e6;
    uint256 internal constant PLATFORM_AMT = 2e6;

    address internal admin = makeAddr("admin"); // holds all three roles
    address internal merchant = makeAddr("merchant");
    address internal creator = makeAddr("creator");
    address internal platform = makeAddr("platform");
    address internal customer = makeAddr("customer");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant ORDER = keccak256("ORDER-001");

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new StableSettleEscrow(IERC20(address(usdc)), admin);

        // Customer holds funds and approves the escrow up front.
        usdc.mint(customer, 1_000e6);
        vm.prank(customer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _split() internal view returns (StableSettleEscrow.Split memory) {
        return StableSettleEscrow.Split({
            merchant: merchant,
            creator: creator,
            platform: platform,
            customer: customer,
            merchantAmount: MERCHANT_AMT,
            refundReserve: REFUND_RESERVE,
            creatorCommission: CREATOR_AMT,
            platformFee: PLATFORM_AMT
        });
    }

    function _create(uint256 window) internal {
        vm.prank(admin);
        escrow.createOrder(ORDER, TOTAL, window, 0, address(0), _split(), "Demo Hoodie", "US");
    }

    function _createWithDuties(uint256 window, uint256 estimatedDuties) internal {
        vm.prank(admin);
        escrow.createOrder(ORDER, TOTAL, window, estimatedDuties, address(0), _split(), "Demo Hoodie", "US");
    }

    function _fund() internal {
        vm.prank(customer);
        escrow.fundOrder(ORDER);
    }

    // ── createOrder ─────────────────────────────────────────────────────────────

    function test_createOrder_storesOrder() public {
        _create(0);
        StableSettleEscrow.Order memory o = escrow.getOrder(ORDER);
        assertEq(o.totalAmount, TOTAL);
        assertEq(uint8(o.state), uint8(StableSettleEscrow.OrderState.Created));
        assertEq(o.split.merchantAmount, MERCHANT_AMT);
    }

    function test_createOrder_rejectsBadSplit() public {
        StableSettleEscrow.Split memory bad = _split();
        bad.merchantAmount = 84e6; // sum now 99, not 100
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(StableSettleEscrow.SplitMismatch.selector, 99e6, TOTAL));
        escrow.createOrder(ORDER, TOTAL, 0, 0, address(0), bad, "Demo Hoodie", "US");
    }

    function test_createOrder_rejectsDuplicate() public {
        _create(0);
        vm.prank(admin);
        vm.expectRevert(StableSettleEscrow.OrderAlreadyExists.selector);
        escrow.createOrder(ORDER, TOTAL, 0, 0, address(0), _split(), "Demo Hoodie", "US");
    }

    function test_createOrder_onlyMerchantRole() public {
        bytes32 role = escrow.MERCHANT_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        escrow.createOrder(ORDER, TOTAL, 0, 0, address(0), _split(), "Demo Hoodie", "US");
    }

    // ── fundOrder ───────────────────────────────────────────────────────────────

    function test_fundOrder_pullsExactAmount() public {
        _create(0);
        uint256 before = usdc.balanceOf(customer);
        _fund();
        assertEq(usdc.balanceOf(customer), before - TOTAL);
        assertEq(usdc.balanceOf(address(escrow)), TOTAL);
        assertEq(uint8(escrow.getOrder(ORDER).state), uint8(StableSettleEscrow.OrderState.Funded));
    }

    function test_fundOrder_revertsIfNotCreated() public {
        _create(0);
        _fund();
        vm.prank(customer);
        vm.expectRevert(StableSettleEscrow.InvalidState.selector);
        escrow.fundOrder(ORDER);
    }

    function test_fundOrder_revertsIfMissing() public {
        vm.prank(customer);
        vm.expectRevert(StableSettleEscrow.OrderNotFound.selector);
        escrow.fundOrder(ORDER);
    }

    // ── Scenario A: normal delivery ──────────────────────────────────────────────

    function test_scenarioA_fullHappyPath() public {
        _create(0); // zero refund window so release is immediately callable
        _fund();

        vm.prank(admin);
        escrow.markDelivered(ORDER);
        StableSettleEscrow.Order memory d = escrow.getOrder(ORDER);
        assertEq(uint8(d.state), uint8(StableSettleEscrow.OrderState.Delivered));
        assertEq(d.deliveredAt, block.timestamp);

        // Anyone can release after the window.
        vm.prank(stranger);
        escrow.release(ORDER);

        assertEq(usdc.balanceOf(merchant), MERCHANT_AMT);
        assertEq(usdc.balanceOf(customer), 1_000e6 - TOTAL + REFUND_RESERVE); // reserve returns to customer
        assertEq(usdc.balanceOf(creator), CREATOR_AMT);
        assertEq(usdc.balanceOf(platform), PLATFORM_AMT);
        assertEq(usdc.balanceOf(address(escrow)), 0); // value conservation
        assertEq(uint8(escrow.getOrder(ORDER).state), uint8(StableSettleEscrow.OrderState.Released));
    }

    function test_release_revertsBeforeWindow() public {
        _create(30); // 30-second refund window
        _fund();
        vm.prank(admin);
        escrow.markDelivered(ORDER);

        uint256 releasableAt = block.timestamp + 30;
        vm.expectRevert(
            abi.encodeWithSelector(
                StableSettleEscrow.RefundWindowNotElapsed.selector, block.timestamp, releasableAt
            )
        );
        escrow.release(ORDER);

        // After the window it succeeds.
        vm.warp(releasableAt);
        escrow.release(ORDER);
        assertEq(uint8(escrow.getOrder(ORDER).state), uint8(StableSettleEscrow.OrderState.Released));
    }

    function test_release_revertsIfNotDelivered() public {
        _create(0);
        _fund();
        vm.expectRevert(StableSettleEscrow.InvalidState.selector);
        escrow.release(ORDER);
    }

    function test_release_doubleReleaseReverts() public {
        _create(0);
        _fund();
        vm.prank(admin);
        escrow.markDelivered(ORDER);
        escrow.release(ORDER);
        vm.expectRevert(StableSettleEscrow.InvalidState.selector);
        escrow.release(ORDER);
    }

    function test_markDelivered_onlyOracleRole() public {
        _create(0);
        _fund();
        bytes32 role = escrow.ORACLE_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        escrow.markDelivered(ORDER);
    }

    // ── Scenario B: dispute ───────────────────────────────────────────────────────

    function test_scenarioB_disputeResolvedSplit() public {
        _create(0);
        _fund();

        // Customer refuses the package.
        vm.prank(customer);
        escrow.raiseDispute(ORDER);
        assertEq(uint8(escrow.getOrder(ORDER).state), uint8(StableSettleEscrow.OrderState.Disputed));

        // Admin resolves: $70 customer, $25 merchant, $0 creator, $5 platform.
        vm.prank(admin);
        escrow.resolveDispute(ORDER, 70e6, 25e6, 0, 5e6);

        assertEq(usdc.balanceOf(customer), 1_000e6 - TOTAL + 70e6);
        assertEq(usdc.balanceOf(merchant), 25e6);
        assertEq(usdc.balanceOf(creator), 0);
        assertEq(usdc.balanceOf(platform), 5e6);
        assertEq(usdc.balanceOf(address(escrow)), 0); // value conservation
        assertEq(uint8(escrow.getOrder(ORDER).state), uint8(StableSettleEscrow.OrderState.Resolved));
    }

    function test_raiseDispute_fromDelivered() public {
        _create(30);
        _fund();
        vm.prank(admin);
        escrow.markDelivered(ORDER);
        vm.prank(admin); // oracle role
        escrow.raiseDispute(ORDER);
        assertEq(uint8(escrow.getOrder(ORDER).state), uint8(StableSettleEscrow.OrderState.Disputed));
    }

    function test_raiseDispute_strangerReverts() public {
        _create(0);
        _fund();
        vm.prank(stranger);
        vm.expectRevert(StableSettleEscrow.InvalidState.selector);
        escrow.raiseDispute(ORDER);
    }

    function test_raiseDispute_revertsFromCreated() public {
        _create(0);
        vm.prank(customer);
        vm.expectRevert(StableSettleEscrow.InvalidState.selector);
        escrow.raiseDispute(ORDER);
    }

    function test_resolveDispute_rejectsBadSum() public {
        _create(0);
        _fund();
        vm.prank(customer);
        escrow.raiseDispute(ORDER);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(StableSettleEscrow.SplitMismatch.selector, 99e6, TOTAL));
        escrow.resolveDispute(ORDER, 70e6, 24e6, 0, 5e6); // sums to 99
    }

    function test_resolveDispute_onlyAdminRole() public {
        _create(0);
        _fund();
        vm.prank(customer);
        escrow.raiseDispute(ORDER);
        bytes32 role = escrow.ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        escrow.resolveDispute(ORDER, 70e6, 25e6, 0, 5e6);
    }

    function test_resolveDispute_doubleResolveReverts() public {
        _create(0);
        _fund();
        vm.prank(customer);
        escrow.raiseDispute(ORDER);
        vm.prank(admin);
        escrow.resolveDispute(ORDER, 70e6, 25e6, 0, 5e6);
        vm.prank(admin);
        vm.expectRevert(StableSettleEscrow.InvalidState.selector);
        escrow.resolveDispute(ORDER, 70e6, 25e6, 0, 5e6);
    }

    function test_resolveDispute_revertsIfNotDisputed() public {
        _create(0);
        _fund();
        vm.prank(admin);
        vm.expectRevert(StableSettleEscrow.InvalidState.selector);
        escrow.resolveDispute(ORDER, 70e6, 25e6, 0, 5e6);
    }

    // ── Scenario C: duties anomaly ────────────────────────────────────────────────

    uint256 internal constant EST_DUTIES = 10e6;

    function _deliverWithDuties(uint256 estimatedDuties) internal {
        _createWithDuties(0, estimatedDuties);
        _fund();
        vm.prank(admin);
        escrow.markDelivered(ORDER);
    }

    function test_scenarioC_anomalyBlocksReleaseThenClears() public {
        _deliverWithDuties(EST_DUTIES);

        // Actual duties are 3× the estimate → auto-flagged.
        vm.prank(admin);
        escrow.reportActualDuties(ORDER, 30e6);
        assertTrue(escrow.getOrder(ORDER).anomalyFlagged);
        assertEq(escrow.getOrder(ORDER).actualDuties, 30e6);

        // Release is blocked while flagged.
        vm.expectRevert(StableSettleEscrow.AnomalyFlaggedRelease.selector);
        escrow.release(ORDER);

        // Admin reviews and clears; release then succeeds.
        vm.prank(admin);
        escrow.clearAnomaly(ORDER);
        assertFalse(escrow.getOrder(ORDER).anomalyFlagged);

        escrow.release(ORDER);
        assertEq(usdc.balanceOf(merchant), MERCHANT_AMT);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.getOrder(ORDER).state), uint8(StableSettleEscrow.OrderState.Released));
    }

    function test_reportActualDuties_noFlagAtThreshold() public {
        _deliverWithDuties(EST_DUTIES);
        vm.prank(admin);
        escrow.reportActualDuties(ORDER, 20e6); // exactly 2× — not above, so no flag
        assertFalse(escrow.getOrder(ORDER).anomalyFlagged);
        escrow.release(ORDER); // unblocked
    }

    function test_reportActualDuties_noFlagWhenNoEstimate() public {
        _deliverWithDuties(0); // no estimate tracked
        vm.prank(admin);
        escrow.reportActualDuties(ORDER, 999e6);
        assertFalse(escrow.getOrder(ORDER).anomalyFlagged);
    }

    function test_reportActualDuties_onlyOracleRole() public {
        _deliverWithDuties(EST_DUTIES);
        bytes32 role = escrow.ORACLE_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        escrow.reportActualDuties(ORDER, 30e6);
    }

    function test_reportActualDuties_revertsIfNotDelivered() public {
        _createWithDuties(0, EST_DUTIES);
        _fund();
        vm.prank(admin);
        vm.expectRevert(StableSettleEscrow.InvalidState.selector);
        escrow.reportActualDuties(ORDER, 30e6);
    }

    function test_clearAnomaly_onlyAdminRole() public {
        _deliverWithDuties(EST_DUTIES);
        vm.prank(admin);
        escrow.reportActualDuties(ORDER, 30e6);
        bytes32 role = escrow.ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        escrow.clearAnomaly(ORDER);
    }

    function test_clearAnomaly_revertsIfNotFlagged() public {
        _deliverWithDuties(EST_DUTIES);
        vm.prank(admin);
        vm.expectRevert(StableSettleEscrow.NotFlagged.selector);
        escrow.clearAnomaly(ORDER);
    }

    // ── multi-currency (EURC) ──────────────────────────────────────────────────────

    function test_eurc_ordersSettleInEurcNotUsdc() public {
        MockEURC eurc = new MockEURC();
        eurc.mint(customer, 1_000e6);
        vm.prank(customer);
        eurc.approve(address(escrow), type(uint256).max);

        bytes32 id = keccak256("EURC-ORDER");
        vm.prank(admin);
        escrow.createOrder(id, TOTAL, 0, 0, address(eurc), _split(), "Leather Handbag", "US->FR");
        assertEq(escrow.getOrder(id).token, address(eurc));

        vm.prank(customer);
        escrow.fundOrder(id);
        assertEq(eurc.balanceOf(address(escrow)), TOTAL);
        assertEq(usdc.balanceOf(address(escrow)), 0); // default token untouched

        vm.prank(admin);
        escrow.markDelivered(id);
        escrow.release(id);

        // Paid out in EURC.
        assertEq(eurc.balanceOf(merchant), MERCHANT_AMT);
        assertEq(eurc.balanceOf(creator), CREATOR_AMT);
        assertEq(eurc.balanceOf(platform), PLATFORM_AMT);
        assertEq(eurc.balanceOf(address(escrow)), 0);
        // USDC never moved for this order.
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function test_defaultToken_usedWhenTokenIsZero() public {
        _create(0); // passes address(0) → defaultToken (usdc)
        assertEq(escrow.getOrder(ORDER).token, address(usdc));
        assertEq(address(escrow.defaultToken()), address(usdc));
    }

    // ── fuzz ──────────────────────────────────────────────────────────────────────

    /// createOrder stores any split whose four buckets sum to the total.
    function testFuzz_createOrder_storesValidSplit(uint256 mAmt, uint256 res, uint256 cr, uint256 pf)
        public
    {
        mAmt = bound(mAmt, 0, 1e30);
        res = bound(res, 0, 1e30);
        cr = bound(cr, 0, 1e30);
        pf = bound(pf, 0, 1e30);
        uint256 total = mAmt + res + cr + pf;
        vm.assume(total > 0);

        StableSettleEscrow.Split memory s = _split();
        s.merchantAmount = mAmt;
        s.refundReserve = res;
        s.creatorCommission = cr;
        s.platformFee = pf;

        vm.prank(admin);
        escrow.createOrder(ORDER, total, 0, 0, address(0), s, "Fuzz", "US");

        StableSettleEscrow.Order memory o = escrow.getOrder(ORDER);
        assertEq(o.totalAmount, total);
        assertEq(o.split.merchantAmount + o.split.refundReserve + o.split.creatorCommission + o.split.platformFee, total);
    }

    /// createOrder rejects any total that doesn't equal the (fixed, valid) bucket sum.
    function testFuzz_createOrder_rejectsBadSum(uint256 total) public {
        uint256 sum = MERCHANT_AMT + REFUND_RESERVE + CREATOR_AMT + PLATFORM_AMT; // 100e6
        total = bound(total, 1, 1e30);
        vm.assume(total != sum);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(StableSettleEscrow.SplitMismatch.selector, sum, total));
        escrow.createOrder(ORDER, total, 0, 0, address(0), _split(), "Fuzz", "US");
    }

    /// resolveDispute pays out any value-conserving split and fully drains the escrow.
    function testFuzz_resolveDispute_conservesValue(uint256 toCustomer, uint256 toMerchant, uint256 toCreator)
        public
    {
        toCustomer = bound(toCustomer, 0, TOTAL);
        toMerchant = bound(toMerchant, 0, TOTAL - toCustomer);
        toCreator = bound(toCreator, 0, TOTAL - toCustomer - toMerchant);
        uint256 toPlatform = TOTAL - toCustomer - toMerchant - toCreator;

        _create(0);
        _fund();
        vm.prank(customer);
        escrow.raiseDispute(ORDER);
        vm.prank(admin);
        escrow.resolveDispute(ORDER, toCustomer, toMerchant, toCreator, toPlatform);

        assertEq(usdc.balanceOf(address(escrow)), 0); // no funds trapped, none minted
        assertEq(uint8(escrow.getOrder(ORDER).state), uint8(StableSettleEscrow.OrderState.Resolved));
    }

    /// resolveDispute rejects any payout that doesn't sum to the total.
    function testFuzz_resolveDispute_rejectsNonConserving(
        uint256 toCustomer,
        uint256 toMerchant,
        uint256 toCreator,
        uint256 toPlatform
    ) public {
        toCustomer = bound(toCustomer, 0, 1e30);
        toMerchant = bound(toMerchant, 0, 1e30);
        toCreator = bound(toCreator, 0, 1e30);
        toPlatform = bound(toPlatform, 0, 1e30);
        uint256 sum = toCustomer + toMerchant + toCreator + toPlatform;
        vm.assume(sum != TOTAL);

        _create(0);
        _fund();
        vm.prank(customer);
        escrow.raiseDispute(ORDER);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(StableSettleEscrow.SplitMismatch.selector, sum, TOTAL));
        escrow.resolveDispute(ORDER, toCustomer, toMerchant, toCreator, toPlatform);
    }

    // ── misc ──────────────────────────────────────────────────────────────────────

    function test_getOrder_revertsIfMissing() public {
        vm.expectRevert(StableSettleEscrow.OrderNotFound.selector);
        escrow.getOrder(keccak256("nope"));
    }

    function test_constructor_rejectsZeroToken() public {
        vm.expectRevert(StableSettleEscrow.ZeroAddress.selector);
        new StableSettleEscrow(IERC20(address(0)), admin);
    }

    // ── security review regressions (2026-11-03) ──────────────────────────────────

    function _deliver() internal {
        vm.prank(admin);
        escrow.markDelivered(ORDER);
    }

    /// The customer can no longer freeze a payout that is already due.
    function test_raiseDispute_customerAfterWindowReverts() public {
        _create(1 days);
        _fund();
        _deliver();
        uint256 closesAt = block.timestamp + 1 days;
        vm.warp(closesAt);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(StableSettleEscrow.DisputeWindowClosed.selector, closesAt, closesAt));
        escrow.raiseDispute(ORDER);
        escrow.release(ORDER); // still releasable by anyone
        assertEq(uint8(escrow.getOrder(ORDER).state), uint8(StableSettleEscrow.OrderState.Released));
    }

    function test_raiseDispute_customerInsideWindow() public {
        _create(1 days);
        _fund();
        _deliver();
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(customer);
        escrow.raiseDispute(ORDER);
        assertEq(uint8(escrow.getOrder(ORDER).state), uint8(StableSettleEscrow.OrderState.Disputed));
    }

    function test_raiseDispute_oracleAfterWindowStillAllowed() public {
        _create(1 days);
        _fund();
        _deliver();
        vm.warp(block.timestamp + 30 days);
        vm.prank(admin); // oracle role
        escrow.raiseDispute(ORDER);
        assertEq(uint8(escrow.getOrder(ORDER).state), uint8(StableSettleEscrow.OrderState.Disputed));
    }
}
