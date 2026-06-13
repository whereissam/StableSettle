// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {StableSettleEscrow} from "../src/StableSettleEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockEURC} from "../src/MockEURC.sol";

/// @notice Runs the demo scenarios against an ALREADY-DEPLOYED escrow, so the events land on the
///         contract the indexer is watching. Reads addresses from env:
///           ESCROW_ADDRESS, USDC_ADDRESS, and optionally EURC_ADDRESS (adds a 4th EURC order).
contract Seed is Script {
    uint256 constant TOTAL = 100e6;

    function run() external {
        address me = msg.sender;
        StableSettleEscrow escrow = StableSettleEscrow(vm.envAddress("ESCROW_ADDRESS"));
        MockUSDC usdc = MockUSDC(vm.envAddress("USDC_ADDRESS"));
        address eurc = vm.envOr("EURC_ADDRESS", address(0));

        vm.startBroadcast();
        usdc.mint(me, 1_000e6);
        usdc.approve(address(escrow), type(uint256).max);

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

        // Scenario A (USDC)
        bytes32 a = keccak256("SEED-A");
        escrow.createOrder(a, TOTAL, 0, 0, address(0), split, "Merino Wool Hoodie", "US -> DE");
        escrow.fundOrder(a);
        escrow.markDelivered(a);
        escrow.release(a);

        // Scenario B (USDC)
        bytes32 b = keccak256("SEED-B");
        escrow.createOrder(b, TOTAL, 0, 0, address(0), split, "Espresso Machine", "US -> DE");
        escrow.fundOrder(b);
        escrow.raiseDispute(b);
        escrow.resolveDispute(b, 70e6, 25e6, 0, 5e6);

        // Scenario C (USDC) — duties anomaly
        bytes32 c = keccak256("SEED-C");
        escrow.createOrder(c, TOTAL, 0, 10e6, address(0), split, "Carbon Road Bike", "US -> DE");
        escrow.fundOrder(c);
        escrow.markDelivered(c);
        escrow.reportActualDuties(c, 35e6);
        escrow.clearAnomaly(c);
        escrow.release(c);

        // Scenario D (EURC) — same happy path, settled in EURC instead of USDC
        if (eurc != address(0)) {
            MockEURC(eurc).mint(me, 1_000e6);
            MockEURC(eurc).approve(address(escrow), type(uint256).max);
            bytes32 d = keccak256("SEED-D");
            escrow.createOrder(d, TOTAL, 0, 0, eurc, split, "Leather Handbag", "US -> FR");
            escrow.fundOrder(d);
            escrow.markDelivered(d);
            escrow.release(d);
        }

        vm.stopBroadcast();
    }
}
