// Canonical contract ABIs, generated from packages/contracts/out. Regenerate after a
// contract change with the snippet in README. Imported as JSON modules.
import escrowAbi from './abi/escrow.json' with { type: 'json' }
import agentVaultAbi from './abi/agentVault.json' with { type: 'json' }
import agentVaultBytecodeJson from './abi/agentVault.bytecode.json' with { type: 'json' }
import erc20Abi from './abi/erc20.json' with { type: 'json' }

// Creation bytecode for deploying AgentVault from the MCP server (viem deployContract).
const agentVaultBytecode = agentVaultBytecodeJson.object as `0x${string}`

export { escrowAbi, agentVaultAbi, agentVaultBytecode, erc20Abi }
