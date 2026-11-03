// viem layer: defines the Arc testnet chain, deploys AgentVaults, and reads vault state.
// The deployer key acts as the human owner; the agent (a Circle wallet) only ever calls spend().

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { agentVaultAbi, agentVaultBytecode, erc20Abi } from '@stablesettle/shared/abi'
import { ARC_TESTNET_CHAIN_ID, chainConfig, fromUsdcUnits } from './config.ts'

let cached: {
  publicClient: PublicClient
  walletClient: WalletClient
  deployer: Address
  usdc: Address | undefined
} | null = null

function clients() {
  if (cached) return cached
  const cfg = chainConfig()
  const account = privateKeyToAccount(cfg.deployerPrivateKey)

  // Arc testnet: USDC is the native gas token; sub-second finality. Chain id is configurable
  // because the public endpoint can change — defaults to a placeholder if unset.
  const arc = defineChain({
    id: cfg.chainId ?? ARC_TESTNET_CHAIN_ID,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: { default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' } },
  })

  const publicClient = createPublicClient({ chain: arc, transport: http(cfg.rpcUrl) })
  const walletClient = createWalletClient({ account, chain: arc, transport: http(cfg.rpcUrl) })

  cached = { publicClient, walletClient, deployer: account.address, usdc: cfg.usdcAddress }
  return cached
}

export function deployerAddress(): Address {
  return clients().deployer
}

export function explorerTxUrl(hash: Hash): string {
  return `https://testnet.arcscan.app/tx/${hash}`
}

export function explorerAddressUrl(addr: Address): string {
  return `https://testnet.arcscan.app/address/${addr}`
}

/** Read an address's USDC balance (base units). Used to pre-flight a spawn before any deploy. */
export async function usdcBalanceOf(address: Address, usdc: Address): Promise<bigint> {
  const { publicClient } = clients()
  return publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  }) as Promise<bigint>
}

export interface DeployVaultParams {
  usdc: Address
  human: Address
  agent: Address
  capUnits: bigint
  agentName: string
  humanProof: `0x${string}`
  /** The sole address `withdraw` may send to (a cold recovery address). Locked at construction. */
  payout: Address
}

/** Deploy an AgentVault and return its address + the deploy tx hash. */
export async function deployVault(p: DeployVaultParams): Promise<{ vault: Address; txHash: Hash }> {
  const { publicClient, walletClient } = clients()
  const account = walletClient.account!

  const txHash = await walletClient.deployContract({
    account,
    chain: walletClient.chain,
    abi: agentVaultAbi,
    bytecode: agentVaultBytecode,
    args: [p.usdc, p.human, p.agent, p.capUnits, p.agentName, p.humanProof, p.payout],
  })

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  if (!receipt.contractAddress) throw new Error('Deployment receipt has no contract address')
  return { vault: receipt.contractAddress, txHash }
}

/** Human owner funds a vault: approve then call fund(amount). Returns the fund tx hash. */
export async function fundVault(vault: Address, usdc: Address, amountUnits: bigint): Promise<Hash> {
  const { publicClient, walletClient } = clients()
  const account = walletClient.account!

  const approveHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: usdc,
    abi: erc20Abi,
    functionName: 'approve',
    args: [vault, amountUnits],
  })
  await publicClient.waitForTransactionReceipt({ hash: approveHash })

  const fundHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: vault,
    abi: agentVaultAbi,
    functionName: 'fund',
    args: [amountUnits],
  })
  await publicClient.waitForTransactionReceipt({ hash: fundHash })
  return fundHash
}

/** Owner sets the per-transaction spend ceiling (0 = off). Deployer must hold HUMAN_OWNER_ROLE. */
export async function setMaxPerSpend(vault: Address, limitUnits: bigint): Promise<Hash> {
  const { publicClient, walletClient } = clients()
  const account = walletClient.account!
  const hash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: vault,
    abi: agentVaultAbi,
    functionName: 'setMaxPerSpend',
    args: [limitUnits],
  })
  await publicClient.waitForTransactionReceipt({ hash })
  return hash
}

/** Owner sets the rolling 24h velocity limit (0 = off). Deployer must hold HUMAN_OWNER_ROLE. */
export async function setDailyLimit(vault: Address, limitUnits: bigint): Promise<Hash> {
  const { publicClient, walletClient } = clients()
  const account = walletClient.account!
  const hash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: vault,
    abi: agentVaultAbi,
    functionName: 'setDailyLimit',
    args: [limitUnits],
  })
  await publicClient.waitForTransactionReceipt({ hash })
  return hash
}

/** Owner turns the recipient allowlist on/off, then approves a batch of addresses. HUMAN_OWNER_ROLE. */
export async function enableAllowlist(vault: Address, recipients: Address[]): Promise<Hash> {
  const { publicClient, walletClient } = clients()
  const account = walletClient.account!
  const enableHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: vault,
    abi: agentVaultAbi,
    functionName: 'setAllowlistEnabled',
    args: [true],
  })
  await publicClient.waitForTransactionReceipt({ hash: enableHash })
  if (recipients.length === 0) return enableHash
  const batchHash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: vault,
    abi: agentVaultAbi,
    functionName: 'setAllowedBatch',
    args: [recipients, true],
  })
  await publicClient.waitForTransactionReceipt({ hash: batchHash })
  return batchHash
}

/**
 * Owner sets a per-recipient sub-budget: "this vendor may receive at most $X total". HUMAN_OWNER_ROLE.
 * Uses `setAllowedWithCap` so the recipient is approved AND capped in one tx (the common flow); pass a
 * 0 cap to approve without a sub-budget. The server signs as the deployer, so this applies only when the
 * configured owner is the deployer (otherwise the cold owner sets it from their own wallet).
 */
export async function setRecipientCap(
  vault: Address,
  recipient: Address,
  capUnits: bigint,
): Promise<Hash> {
  const { publicClient, walletClient } = clients()
  const account = walletClient.account!
  const hash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: vault,
    abi: agentVaultAbi,
    functionName: 'setAllowedWithCap',
    args: [recipient, true, capUnits],
  })
  await publicClient.waitForTransactionReceipt({ hash })
  return hash
}

/** Read a single recipient's remaining per-recipient sub-budget. max uint256 means no cap is set. */
export async function readRecipientCap(
  vault: Address,
  recipient: Address,
): Promise<{ cap: bigint; spent: bigint; remaining: bigint }> {
  const { publicClient } = clients()
  const read = <T>(functionName: string) =>
    publicClient.readContract({ address: vault, abi: agentVaultAbi, functionName, args: [recipient] }) as Promise<T>
  const [cap, spent, remaining] = await Promise.all([
    read<bigint>('recipientCap'),
    read<bigint>('recipientSpent'),
    read<bigint>('recipientRemaining'),
  ])
  return { cap, spent, remaining }
}

/** Send a small amount of USDC to the agent wallet so it can pay gas (USDC is gas on Arc). */
export async function topUpGas(agent: Address, usdc: Address, amountUnits: bigint): Promise<Hash> {
  const { publicClient, walletClient } = clients()
  const account = walletClient.account!
  const hash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: usdc,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [agent, amountUnits],
  })
  await publicClient.waitForTransactionReceipt({ hash })
  return hash
}

/**
 * Map an AgentVault.spend() custom-error revert to a clear, human-readable reason.
 * Returns undefined if the error isn't a decodable contract revert (caller should rethrow).
 */
function friendlySpendRevert(e: unknown, to: Address): string | undefined {
  if (!(e instanceof BaseError)) return undefined
  const revert = e.walk((err) => err instanceof ContractFunctionRevertedError)
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined
  const name = revert.data?.errorName
  const a = (revert.data?.args ?? []) as readonly unknown[]
  const usd = (v: unknown) => `$${fromUsdcUnits(v as bigint)}`
  switch (name) {
    case 'BudgetExceeded':
      return `Reverted on-chain: BudgetExceeded — requested ${usd(a[0])} but only ${usd(a[1])} of the lifetime budget cap remains. The vault refused it; no funds moved.`
    case 'RecipientNotAllowed':
      return `Reverted on-chain: RecipientNotAllowed(${to}) — the recipient allowlist is ON and this address is not on it. Even within budget, the agent cannot pay an address the owner didn't approve.`
    case 'RecipientCapExceeded':
      // args: (address recipient, uint256 requested, uint256 remaining)
      return `Reverted on-chain: RecipientCapExceeded(${to}) — requested ${usd(a[1])} but this recipient has only ${usd(a[2])} left under its per-recipient sub-budget. The destination is approved and the lifetime budget is fine, yet this specific vendor has hit its own ceiling.`
    case 'DailyLimitExceeded':
      return `Reverted on-chain: DailyLimitExceeded — requested ${usd(a[0])} but only ${usd(a[1])} remains in the rolling 24h velocity limit. The agent can't burst-drain, even to an approved address.`
    case 'PerSpendLimitExceeded':
      return `Reverted on-chain: PerSpendLimitExceeded — requested ${usd(a[0])} exceeds the ${usd(a[1])} per-transaction ceiling.`
    case 'InsufficientBalance':
      return `Reverted on-chain: InsufficientBalance — the vault treasury holds ${usd(a[1])} but ${usd(a[0])} was requested. Top it up with fund_agent. (The budget cap was not the blocker.)`
    case 'AgentRevoked':
      return `Reverted on-chain: AgentRevoked — this agent was revoked by its owner and can no longer spend.`
    case 'ZeroAmount':
      return `Reverted on-chain: ZeroAmount — the amount must be greater than zero.`
    case 'ZeroAddress':
      return `Reverted on-chain: ZeroAddress — the recipient cannot be the zero address.`
    default:
      return name ? `Reverted on-chain: ${name}.` : undefined
  }
}

/**
 * Dry-run AgentVault.spend(to, amount) as the agent (off-chain eth_call) BEFORE the real
 * Circle execution. If an on-chain guard would reject it, throw a clean, named reason instantly
 * — instead of waiting ~2 min for Circle to report a generic "FAILED" and burning gas on a
 * doomed tx. This is what makes the firewall demo land: "RecipientNotAllowed", not "FAILED".
 */
export async function simulateSpend(
  vault: Address,
  agent: Address,
  to: Address,
  amountUnits: bigint,
): Promise<void> {
  const { publicClient } = clients()
  try {
    await publicClient.simulateContract({
      account: agent,
      address: vault,
      abi: agentVaultAbi,
      functionName: 'spend',
      args: [to, amountUnits],
    })
  } catch (e) {
    const friendly = friendlySpendRevert(e, to)
    if (friendly) throw new Error(friendly)
    throw e
  }
}

export interface VaultState {
  budgetCap: bigint
  spent: bigint
  remaining: bigint
  balance: bigint
  active: boolean
  agentName: string
  humanProof: `0x${string}`
  token: Address
  maxPerSpend: bigint
  dailyLimit: bigint
  allowlistEnabled: boolean
}

/** Read the full on-chain state of a vault (source of truth for status cards). */
export async function readVault(vault: Address): Promise<VaultState> {
  const { publicClient } = clients()
  const read = <T>(functionName: string) =>
    publicClient.readContract({ address: vault, abi: agentVaultAbi, functionName }) as Promise<T>

  // Newer fields (maxPerSpend, dailyLimit) don't exist on vaults deployed with older bytecode — their
  // getter reverts. Read them tolerantly so `get_agent` still works on pre-existing vaults (default 0 = off).
  const readOptional = (functionName: string) => read<bigint>(functionName).catch(() => 0n)

  const [budgetCap, spent, remaining, balance, active, agentName, humanProof, token, maxPerSpend, dailyLimit] =
    await Promise.all([
      read<bigint>('budgetCap'),
      read<bigint>('spent'),
      read<bigint>('budgetRemaining'),
      read<bigint>('balance'),
      read<boolean>('active'),
      read<string>('agentName'),
      read<`0x${string}`>('humanProof'),
      read<Address>('token'),
      readOptional('maxPerSpend'),
      readOptional('dailyLimit'),
    ])
  // allowlistEnabled is newer than the earliest vaults — its getter reverts on older bytecode, so read
  // it tolerantly (false = off) instead of failing the whole load for a pre-existing vault.
  const allowlistEnabled = await read<boolean>('allowlistEnabled').catch(() => false)

  return {
    budgetCap,
    spent,
    remaining,
    balance,
    active,
    agentName,
    humanProof,
    token,
    maxPerSpend,
    dailyLimit,
    allowlistEnabled,
  }
}
