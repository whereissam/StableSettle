// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {StableSettleEscrow} from "../src/StableSettleEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockEURC} from "../src/MockEURC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deploys StableSettleEscrow on Arc testnet.
///
/// Token selection:
///   - If env USDC_ADDRESS is set (e.g. Arc's native USDC 0x3600...0000), the escrow
///     is pointed at it directly.
///   - Otherwise a MockUSDC (public mint) is deployed so the demo is self-contained.
///
/// The deployer is granted MERCHANT_ROLE, ORACLE_ROLE and ADMIN_ROLE for the demo.
/// Run with:
///   forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_TESTNET_RPC_URL --account <keystore> --broadcast
contract Deploy is Script {
    function run() external {
        address deployer = msg.sender;

        // Read optional pre-existing token addresses (0 means "deploy a Mock").
        address usdcAddress = vm.envOr("USDC_ADDRESS", address(0));
        address eurcAddress = vm.envOr("EURC_ADDRESS", address(0));

        vm.startBroadcast();

        IERC20 usdc;
        IERC20 eurc;
        bool usedMock;
        if (usdcAddress == address(0)) {
            MockUSDC m = new MockUSDC();
            m.mint(deployer, 100_000e6); // 100k demo USDC to the deployer
            usdc = IERC20(address(m));
            usedMock = true;
        } else {
            usdc = IERC20(usdcAddress);
        }
        if (eurcAddress == address(0)) {
            MockEURC m = new MockEURC();
            m.mint(deployer, 100_000e6); // 100k demo EURC to the deployer
            eurc = IERC20(address(m));
        } else {
            eurc = IERC20(eurcAddress);
        }

        // USDC is the escrow's default token; EURC is available as a per-order token.
        StableSettleEscrow escrow = new StableSettleEscrow(usdc, deployer);

        vm.stopBroadcast();

        console2.log("Deployer:        ", deployer);
        console2.log("USDC token:      ", address(usdc), usedMock ? "(MockUSDC)" : "(provided)");
        console2.log("EURC token:      ", address(eurc));
        console2.log("StableSettleEscrow:", address(escrow));

        _writeDeployments(address(escrow), address(usdc), address(eurc), deployer, usedMock);
    }

    /// @dev Emit a JSON config the frontend imports directly (apps/web/src/deployments.json).
    function _writeDeployments(address escrow, address usdc, address eurc, address deployer, bool usedMock)
        internal
    {
        string memory obj = "deployments";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "escrow", escrow);
        vm.serializeAddress(obj, "usdc", usdc);
        vm.serializeAddress(obj, "eurc", eurc);
        vm.serializeBool(obj, "usdcIsMock", usedMock);
        string memory json = vm.serializeAddress(obj, "deployer", deployer);

        string memory path = "../../apps/web/src/deployments.json";
        vm.writeJson(json, path);
        console2.log("Wrote deployment config to apps/web/src/deployments.json");
    }
}
