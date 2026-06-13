// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {StableSettleEscrow} from "../src/StableSettleEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Live end-to-end walkthrough of all three scenarios as real broadcast transactions.
///         One account plays every role + the customer (mirrors the demo wallet). Run against anvil:
///           forge script script/E2E.s.sol:E2E --rpc-url http://127.0.0.1:8545 \
///             --private-key <anvil_key> --broadcast
contract E2E is Script {
    uint256 constant TOTAL = 100e6;

    function run() external {
        address me = msg.sender;

        vm.startBroadcast();

        MockUSDC usdc = new MockUSDC();
        StableSettleEscrow escrow = new StableSettleEscrow(IERC20(address(usdc)), me);
        usdc.mint(me, 1_000e6);
        usdc.approve(address(escrow), type(uint256).max);
        console2.log("Deployed. USDC:", address(usdc), "escrow:", address(escrow));

        StableSettleEscrow.Split memory split = StableSettleEscrow.Split({
            merchant: me,
            creator: me,
            platform: me,
            customer: me,
            merchantAmount: 85e6,
            refundReserve: 8e6,
            creatorCommission: 5e6,
            platformFee: 2e6
        });

        // ── Scenario A: normal delivery ──────────────────────────────────────────
        bytes32 a = keccak256("E2E-A");
        escrow.createOrder(a, TOTAL, 0, 0, address(0), split, "Hoodie", "US->DE");
        _expectState(escrow, a, StableSettleEscrow.OrderState.Created, "A created");
        escrow.fundOrder(a);
        _expectState(escrow, a, StableSettleEscrow.OrderState.Funded, "A funded");
        require(usdc.balanceOf(address(escrow)) == TOTAL, "A: escrow should hold 100");
        escrow.markDelivered(a);
        _expectState(escrow, a, StableSettleEscrow.OrderState.Delivered, "A delivered");
        escrow.release(a);
        _expectState(escrow, a, StableSettleEscrow.OrderState.Released, "A released");
        require(usdc.balanceOf(address(escrow)) == 0, "A: escrow drained");
        console2.log(unicode"Scenario A OK ✓ (create->fund->deliver->release)");

        // ── Scenario B: dispute ──────────────────────────────────────────────────
        bytes32 b = keccak256("E2E-B");
        escrow.createOrder(b, TOTAL, 0, 0, address(0), split, "Espresso", "US->DE");
        escrow.fundOrder(b);
        escrow.raiseDispute(b);
        _expectState(escrow, b, StableSettleEscrow.OrderState.Disputed, "B disputed");
        escrow.resolveDispute(b, 70e6, 25e6, 0, 5e6);
        _expectState(escrow, b, StableSettleEscrow.OrderState.Resolved, "B resolved");
        require(usdc.balanceOf(address(escrow)) == 0, "B: escrow drained");
        console2.log(unicode"Scenario B OK ✓ (create->fund->dispute->resolve 70/25/0/5)");

        // ── Scenario C: duties anomaly ───────────────────────────────────────────
        bytes32 c = keccak256("E2E-C");
        escrow.createOrder(c, TOTAL, 0, 10e6, address(0), split, "Road Bike", "US->DE"); // est duties $10
        escrow.fundOrder(c);
        escrow.markDelivered(c);
        escrow.reportActualDuties(c, 35e6); // 3.5x estimate -> auto-flag
        require(escrow.getOrder(c).anomalyFlagged, "C: should be flagged");
        console2.log(unicode"  C flagged after duties report ✓ (release would revert here)");
        escrow.clearAnomaly(c);
        require(!escrow.getOrder(c).anomalyFlagged, "C: should be cleared");
        escrow.release(c);
        _expectState(escrow, c, StableSettleEscrow.OrderState.Released, "C released");
        require(usdc.balanceOf(address(escrow)) == 0, "C: escrow drained");
        console2.log(unicode"Scenario C OK ✓ (deliver->report duties->flag->clear->release)");

        vm.stopBroadcast();

        console2.log(unicode"\nAll three scenarios passed end to end on-chain ✓");
    }

    function _expectState(
        StableSettleEscrow escrow,
        bytes32 id,
        StableSettleEscrow.OrderState want,
        string memory label
    ) internal view {
        StableSettleEscrow.OrderState got = escrow.getOrder(id).state;
        require(got == want, label);
    }
}
