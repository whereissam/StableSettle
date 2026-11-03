import { createPublicClient, http, isAddress, type Address } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { normalize } from 'viem/ens'

/**
 * ENS resolution runs on the network where our parent domain (e.g. stablesettle.eth) is configured —
 * Sepolia by default for the demo (matches the MCP server's NAMESTONE_NETWORK). NameStone serves the
 * agent subnames via a CCIP-Read offchain resolver, which viem follows automatically. So this is a
 * REAL, standard ENS client reading the records over public infrastructure — not our backend. It's the
 * round-trip proof: the name the vault records on Arc, resolved + its policy read back through ENS.
 */
const ENS_NETWORK = (import.meta.env.VITE_ENS_NETWORK as string | undefined) === 'mainnet' ? 'mainnet' : 'sepolia'
const ENS_CHAIN = ENS_NETWORK === 'mainnet' ? mainnet : sepolia
const ENS_RPC = import.meta.env.VITE_ENS_RPC_URL as string | undefined

export const ensNetwork = ENS_NETWORK

const ensClient = createPublicClient({
  chain: ENS_CHAIN,
  transport: ENS_RPC ? http(ENS_RPC) : http(),
})

export interface EnsResolution {
  name: string
  /** Address the ENS name resolves to (null if the name isn't set up / doesn't resolve). */
  resolvedAddress: Address | null
  /** The `spend-policy` text record (raw JSON string), if present. */
  spendPolicy: string | null
  /** The `budget-cap` text record — human dollar string, e.g. "500". */
  budgetCap: string | null
  /** The `agent-vault` text record — the AgentVault address the policy is enforced by. */
  agentVault: string | null
}

const EMPTY = (name: string): EnsResolution => ({
  name,
  resolvedAddress: null,
  spendPolicy: null,
  budgetCap: null,
  agentVault: null,
})

/**
 * Resolve an agent's ENS name + spend-policy text records with a standard CCIP-Read ENS client.
 * Degrades gracefully (all-null) when the name isn't configured to resolve, so the UI can say so
 * honestly instead of erroring.
 */
export async function resolveAgentEns(name: string): Promise<EnsResolution> {
  let norm: string
  try {
    norm = normalize(name)
  } catch {
    return EMPTY(name)
  }

  const [resolvedAddress, spendPolicy, budgetCap, agentVault] = await Promise.all([
    ensClient.getEnsAddress({ name: norm }).catch(() => null),
    ensClient.getEnsText({ name: norm, key: 'spend-policy' }).catch(() => null),
    ensClient.getEnsText({ name: norm, key: 'budget-cap' }).catch(() => null),
    ensClient.getEnsText({ name: norm, key: 'agent-vault' }).catch(() => null),
  ])

  return {
    name,
    resolvedAddress: resolvedAddress && isAddress(resolvedAddress) ? resolvedAddress : null,
    spendPolicy,
    budgetCap,
    agentVault,
  }
}
