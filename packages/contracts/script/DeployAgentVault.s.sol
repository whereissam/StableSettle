// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deploys a single AgentVault on Arc testnet — the budget-capped treasury behind
///         `arc:spawn-agent`. In the live product the MCP server deploys these at runtime; this
///         script is for manual deploys, local testing, and demos.
///
/// Configuration (env):
///   - USDC_ADDRESS   the settlement token. If unset, a MockUSDC (public mint) is deployed.
///   - HUMAN_ADDRESS  the human owner. Defaults to the deployer.
///   - AGENT_ADDRESS  the agent wallet (granted AGENT_ROLE). Defaults to the deployer (demo only).
///   - BUDGET_CAP     lifetime spend cap in token units. Defaults to 5000e6 (5,000 USDC).
///   - AGENT_NAME     the agent's ENS name, recorded as provenance. Defaults to a demo name.
///   - OWNER_PAYOUT   the sole address withdraw can send to (a cold recovery address). Defaults to
///                    HUMAN_ADDRESS. Set a distinct cold address to neutralise an owner-key leak.
///
/// Run with:
///   AGENT_ADDRESS=0x… forge script script/DeployAgentVault.s.sol:DeployAgentVault \
///     --rpc-url $ARC_TESTNET_RPC_URL --account <keystore> --broadcast
contract DeployAgentVault is Script {
    function run() external {
        address deployer = msg.sender;

        address usdcAddress = vm.envOr("USDC_ADDRESS", address(0));
        address human = vm.envOr("HUMAN_ADDRESS", deployer);
        address agent = vm.envOr("AGENT_ADDRESS", deployer);
        uint256 cap = vm.envOr("BUDGET_CAP", uint256(5_000e6));
        string memory name = vm.envOr("AGENT_NAME", string("trader-bot.stablesettle.eth"));
        // World ID nullifier is recorded by the MCP server at runtime; 0 for a script deploy.
        bytes32 proof = bytes32(0);
        // Sole withdraw destination. Defaults to the human owner; pass a cold address for production.
        address payout = vm.envOr("OWNER_PAYOUT", human);

        vm.startBroadcast();

        IERC20 usdc;
        bool usedMock;
        if (usdcAddress == address(0)) {
            MockUSDC m = new MockUSDC();
            m.mint(human, 100_000e6); // fund the human so they can top up the vault
            usdc = IERC20(address(m));
            usedMock = true;
        } else {
            usdc = IERC20(usdcAddress);
        }

        AgentVault vault = new AgentVault(usdc, human, agent, cap, name, proof, payout);

        vm.stopBroadcast();

        console2.log("Deployer:    ", deployer);
        console2.log("USDC token:  ", address(usdc), usedMock ? "(MockUSDC)" : "(provided)");
        console2.log("Human owner: ", human);
        console2.log("Agent:       ", agent);
        console2.log("AgentVault:  ", address(vault));
        console2.log("Budget cap:  ", cap);
        console2.log("Agent name:  ", name);

        _writeDeployments(address(vault), address(usdc), human, agent, cap, name, usedMock);
    }

    /// @dev Emit a JSON config the MCP server / frontend can read (apps/web/src/agent-deployments.json).
    function _writeDeployments(
        address vault,
        address usdc,
        address human,
        address agent,
        uint256 cap,
        string memory name,
        bool usedMock
    ) internal {
        string memory obj = "agentDeployments";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "vault", vault);
        vm.serializeAddress(obj, "usdc", usdc);
        vm.serializeBool(obj, "usdcIsMock", usedMock);
        vm.serializeAddress(obj, "human", human);
        vm.serializeAddress(obj, "agent", agent);
        vm.serializeUint(obj, "budgetCap", cap);
        string memory json = vm.serializeString(obj, "agentName", name);

        string memory path = "../../apps/web/src/agent-deployments.json";
        vm.writeJson(json, path);
        console2.log("Wrote deployment config to apps/web/src/agent-deployments.json");
    }
}
