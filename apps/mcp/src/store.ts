// A tiny JSON-backed registry mapping agent name -> its vault + Circle wallet, so agent_pay and
// get_agent can be addressed by name. The contract remains the source of truth for balances/spend;
// this only records the wiring (which wallet, which vault) that isn't derivable from chain alone.

import { agentStorePath } from './config.ts'

export interface AgentRecord {
  name: string
  ensName: string
  vault: `0x${string}`
  agentAddress: `0x${string}`
  circleWalletId: string
  human: `0x${string}`
  usdc: `0x${string}`
  createdTx: `0x${string}`
  /** World ID nullifier this agent was spawned with (zero/absent if not verified). */
  humanProof?: `0x${string}`
}

const ZERO_NULLIFIER = `0x${'0'.repeat(64)}`

type Store = Record<string, AgentRecord>

async function read(): Promise<Store> {
  try {
    const file = Bun.file(agentStorePath())
    if (!(await file.exists())) return {}
    return (await file.json()) as Store
  } catch {
    return {}
  }
}

async function write(store: Store): Promise<void> {
  await Bun.write(agentStorePath(), JSON.stringify(store, null, 2))
}

export async function saveAgent(record: AgentRecord): Promise<void> {
  const store = await read()
  store[record.name] = record
  await write(store)
}

export async function getAgent(name: string): Promise<AgentRecord | undefined> {
  return (await read())[name]
}

export async function listAgents(): Promise<AgentRecord[]> {
  return Object.values(await read())
}

/**
 * Has this World ID nullifier already backed an agent? Enforces "one human → one agent per action"
 * so a single proof can't be replayed to spawn unlimited "verified" agents (Sybil). Off-chain dedup;
 * the on-chain `humanProof` is provenance, not a uniqueness gate.
 */
export async function nullifierUsed(nullifier: string): Promise<boolean> {
  if (!nullifier || nullifier.toLowerCase() === ZERO_NULLIFIER) return false
  const store = await read()
  return Object.values(store).some((a) => a.humanProof?.toLowerCase() === nullifier.toLowerCase())
}
