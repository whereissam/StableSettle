// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice A demo-only ERC-20 standing in for USDC. 6 decimals, like real USDC.
/// @dev `mint` is intentionally public so the demo is self-contained and does not
///      depend on a faucet. On a real deployment the escrow is pointed at Arc's
///      native USDC (0x3600...0000) instead — see script/Deploy.s.sol.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "USDC") {}

    /// @notice USDC uses 6 decimals, not the ERC-20 default of 18.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Anyone can mint to any address — DEMO ONLY.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
