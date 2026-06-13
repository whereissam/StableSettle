// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {StableSettleEscrow} from "../src/StableSettleEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Drives random sequences of every escrow transition. All recipients are the handler
///         itself, so funds that leave the escrow return here — the escrow balance should always
///         equal the total of orders whose funds are still in escrow (Funded/Delivered/Disputed).
contract EscrowHandler is Test {
    StableSettleEscrow public escrow;
    MockUSDC public usdc;
    bytes32[] public ids;
    uint256 internal nonce;

    constructor(StableSettleEscrow _escrow, MockUSDC _usdc) {
        escrow = _escrow;
        usdc = _usdc;
        usdc.mint(address(this), 1e33);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function _split(uint256 total) internal view returns (StableSettleEscrow.Split memory) {
        address me = address(this);
        // Everything in the merchant bucket; all recipients are the handler.
        return StableSettleEscrow.Split({
            merchant: me,
            creator: me,
            platform: me,
            customer: me,
            merchantAmount: total,
            refundReserve: 0,
            creatorCommission: 0,
            platformFee: 0
        });
    }

    function _pick(uint256 seed) internal view returns (bytes32) {
        return ids[seed % ids.length];
    }

    // Each action targets an existing order (or creates one) and swallows invalid-state reverts,
    // so the fuzzer is free to call them in any order.

    function createOrder(uint256 totalSeed, uint256 estSeed) external {
        uint256 total = bound(totalSeed, 1, 1e24);
        uint256 est = bound(estSeed, 0, total);
        bytes32 id = keccak256(abi.encode("order", nonce++));
        try escrow.createOrder(id, total, 0, est, address(0), _split(total), "", "") {
            ids.push(id);
        } catch {}
    }

    function fund(uint256 seed) external {
        if (ids.length == 0) return;
        try escrow.fundOrder(_pick(seed)) {} catch {}
    }

    function deliver(uint256 seed) external {
        if (ids.length == 0) return;
        try escrow.markDelivered(_pick(seed)) {} catch {}
    }

    function reportDuties(uint256 seed, uint256 dutiesSeed) external {
        if (ids.length == 0) return;
        try escrow.reportActualDuties(_pick(seed), bound(dutiesSeed, 0, 1e24)) {} catch {}
    }

    function clearAnomaly(uint256 seed) external {
        if (ids.length == 0) return;
        try escrow.clearAnomaly(_pick(seed)) {} catch {}
    }

    function release(uint256 seed) external {
        if (ids.length == 0) return;
        try escrow.release(_pick(seed)) {} catch {}
    }

    function dispute(uint256 seed) external {
        if (ids.length == 0) return;
        try escrow.raiseDispute(_pick(seed)) {} catch {}
    }

    function resolve(uint256 seed) external {
        if (ids.length == 0) return;
        bytes32 id = _pick(seed);
        try escrow.getOrder(id) returns (StableSettleEscrow.Order memory o) {
            // Conserving split, everything to the customer (the handler).
            try escrow.resolveDispute(id, o.totalAmount, 0, 0, 0) {} catch {}
        } catch {}
    }

    /// Sum of funds that should still be sitting in the escrow.
    function expectedHeld() external view returns (uint256 sum) {
        for (uint256 i = 0; i < ids.length; i++) {
            StableSettleEscrow.Order memory o = escrow.getOrder(ids[i]);
            if (
                o.state == StableSettleEscrow.OrderState.Funded
                    || o.state == StableSettleEscrow.OrderState.Delivered
                    || o.state == StableSettleEscrow.OrderState.Disputed
            ) {
                sum += o.totalAmount;
            }
        }
    }
}

contract StableSettleEscrowInvariantTest is StdInvariant, Test {
    StableSettleEscrow internal escrow;
    MockUSDC internal usdc;
    EscrowHandler internal handler;

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new StableSettleEscrow(IERC20(address(usdc)), address(this)); // test holds DEFAULT_ADMIN
        handler = new EscrowHandler(escrow, usdc);

        // The handler must be allowed to play every role.
        escrow.grantRole(escrow.MERCHANT_ROLE(), address(handler));
        escrow.grantRole(escrow.ORACLE_ROLE(), address(handler));
        escrow.grantRole(escrow.ADMIN_ROLE(), address(handler));

        targetContract(address(handler));
    }

    /// The escrow never holds more or less than the funds of its unreleased orders:
    /// no value is minted, none is trapped.
    function invariant_escrowBalanceEqualsUnreleasedFunds() public view {
        assertEq(usdc.balanceOf(address(escrow)), handler.expectedHeld());
    }
}
