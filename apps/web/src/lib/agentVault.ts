import type { Abi, Address, PublicClient } from 'viem'
import { parseAbiItem } from 'viem'
import agentVaultAbiJson from './abi/AgentVault.json'

export const agentVaultAbi = agentVaultAbiJson as Abi

/** Sentinel `dailyRemaining()` returns when no daily limit is set (type(uint256).max). */
export const UINT256_MAX = (1n << 256n) - 1n

/** health() status codes — must match AgentVault.health(). */
export type VaultHealth = 'healthy' | 'warning' | 'frozen'
export function healthFromStatus(status: number): VaultHealth {
  return status === 2 ? 'frozen' : status === 1 ? 'warning' : 'healthy'
}

export interface VaultState {
  address: Address
  agentName: string
  budgetCap: bigint
  spent: bigint
  capRemaining: bigint
  balance: bigint
  active: boolean
  /** 0 = no daily limit. */
  dailyLimit: bigint
  /** Spendable in the current 24h window. UINT256_MAX when no daily limit is set. */
  todayRemaining: bigint
  health: VaultHealth
}

export interface SpendEntry {
  to: Address
  amount: bigint
  spentTotal: bigint
  remaining: bigint
  blockNumber: bigint
  txHash: `0x${string}`
}

const SPENT_EVENT = parseAbiItem(
  'event Spent(address indexed agent, address indexed to, uint256 amount, uint256 spentTotal, uint256 remaining)',
)

/** Read the full vault state in one fan-out. `health()` is read on-chain — not derived off-chain. */
export async function readVault(client: PublicClient, address: Address): Promise<VaultState> {
  const c = { address, abi: agentVaultAbi } as const
  const [agentName, budgetCap, spent, balance, active, dailyLimit, health] = (await Promise.all([
    client.readContract({ ...c, functionName: 'agentName' }),
    client.readContract({ ...c, functionName: 'budgetCap' }),
    client.readContract({ ...c, functionName: 'spent' }),
    client.readContract({ ...c, functionName: 'balance' }),
    client.readContract({ ...c, functionName: 'active' }),
    client.readContract({ ...c, functionName: 'dailyLimit' }),
    client.readContract({ ...c, functionName: 'health' }),
  ])) as [string, bigint, bigint, bigint, boolean, bigint, readonly [number, bigint, bigint]]

  const [status, capRemaining, todayRemaining] = health
  return {
    address,
    agentName,
    budgetCap,
    spent,
    capRemaining,
    balance,
    active,
    dailyLimit,
    todayRemaining,
    health: healthFromStatus(Number(status)),
  }
}

/**
 * Recent `Spent` events for a vault, newest first. Vaults are deployed at arbitrary times by the MCP
 * server, so we scan the last ~9k blocks — within Arc's 10k-block eth_getLogs cap. Set
 * VITE_VAULT_FROM_BLOCK to a vault's deploy block to widen the window.
 */
export async function readSpendHistory(client: PublicClient, address: Address): Promise<SpendEntry[]> {
  const latest = await client.getBlockNumber()
  const pinned = import.meta.env.VITE_VAULT_FROM_BLOCK
  let fromBlock = latest > 9000n ? latest - 9000n : 0n
  try {
    if (pinned) fromBlock = BigInt(pinned)
  } catch {
    /* ignore a malformed env value */
  }

  const logs = await client.getLogs({ address, event: SPENT_EVENT, fromBlock, toBlock: latest })
  return logs
    .map((l) => ({
      to: (l.args as { to: Address }).to,
      amount: (l.args as { amount: bigint }).amount,
      spentTotal: (l.args as { spentTotal: bigint }).spentTotal,
      remaining: (l.args as { remaining: bigint }).remaining,
      blockNumber: l.blockNumber ?? 0n,
      txHash: l.transactionHash ?? ('0x' as `0x${string}`),
    }))
    .reverse()
}
