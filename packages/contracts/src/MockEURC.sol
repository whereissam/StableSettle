// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockEURC
/// @notice A demo-only ERC-20 standing in for EURC. 6 decimals, like real EURC.
/// @dev Public `mint` so the multi-currency demo is self-contained. On a real deployment
///      the escrow settles orders in Arc's native EURC (0x89B5...D72a) instead.
contract MockEURC is ERC20 {
    constructor() ERC20("Mock Euro Coin", "EURC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Anyone can mint to any address — DEMO ONLY.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
