// Circle Developer-Controlled Wallets wrapper. This is what gives the agent an *isolated*
// server wallet it signs with — the "spawn an isolated wallet" moment of arc:spawn-agent.
// The agent only ever executes AgentVault.spend(); the budget cap is enforced on-chain.

import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'
import { circleConfig } from './config.ts'

type CircleClient = ReturnType<typeof initiateDeveloperControlledWalletsClient>

let client: CircleClient | null = null
let walletSetId: string | undefined

function getClient(): CircleClient {
  if (client) return client
  const cfg = circleConfig()
  client = initiateDeveloperControlledWalletsClient({ apiKey: cfg.apiKey, entitySecret: cfg.entitySecret })
  walletSetId = cfg.walletSetId
  return client
}

const TERMINAL = new Set(['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'])

async function ensureWalletSet(name: string): Promise<string> {
  if (walletSetId) return walletSetId
  const res = await getClient().createWalletSet({ name })
  const id = res.data?.walletSet?.id
  if (!id) throw new Error('Circle createWalletSet returned no id')
  walletSetId = id
  return id
}

export interface AgentWallet {
  walletId: string
  address: `0x${string}`
}

/** Spawn a fresh isolated EOA wallet for an agent on Arc. */
export async function createAgentWallet(agentName: string): Promise<AgentWallet> {
  const cfg = circleConfig()
  const setId = await ensureWalletSet(`stablesettle-agents`)
  const res = await getClient().createWallets({
    accountType: 'EOA',
    blockchains: [cfg.blockchain as never],
    count: 1,
    walletSetId: setId,
    metadata: [{ name: agentName }],
  })
  const wallet = res.data?.wallets?.[0]
  if (!wallet?.id || !wallet.address) throw new Error('Circle createWallets returned no wallet')
  return { walletId: wallet.id, address: wallet.address as `0x${string}` }
}

/** Poll a Circle transaction until it reaches a terminal state; return its on-chain tx hash. */
async function waitForTx(id: string): Promise<{ state: string; txHash: `0x${string}` | undefined }> {
  // ~2 minutes of polling at 2s intervals. Production should use Circle webhooks instead.
  for (let i = 0; i < 60; i++) {
    const res = await getClient().getTransaction({ id })
    const tx = res.data?.transaction
    const state = tx?.state ?? 'INITIATED'
    if (TERMINAL.has(state)) {
      if (state !== 'COMPLETE') {
        throw new Error(`Circle transaction ${id} ended in state ${state}`)
      }
      return { state, txHash: tx?.txHash as `0x${string}` | undefined }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`Circle transaction ${id} did not reach a terminal state in time`)
}

/** Have the agent wallet call AgentVault.spend(to, amount). Returns the on-chain tx hash. */
export async function executeSpend(
  walletId: string,
  vault: `0x${string}`,
  to: `0x${string}`,
  amountUnits: bigint,
): Promise<{ txHash: `0x${string}` | undefined }> {
  const res = await getClient().createContractExecutionTransaction({
    walletId,
    contractAddress: vault,
    abiFunctionSignature: 'spend(address,uint256)',
    abiParameters: [to, amountUnits.toString()],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    idempotencyKey: crypto.randomUUID(),
  })
  const id = res.data?.id
  if (!id) throw new Error('Circle createContractExecutionTransaction returned no id')
  return waitForTx(id)
}
