// viem layer: defines the Arc testnet chain, deploys AgentVaults, and reads vault state.
// The deployer key acts as the human owner; the agent (a Circle wallet) only ever calls spend().

import {
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
import { ARC_TESTNET_CHAIN_ID, chainConfig } from './config.ts'

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
    args: [p.usdc, p.human, p.agent, p.capUnits, p.agentName, p.humanProof],
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

  return { budgetCap, spent, remaining, balance, active, agentName, humanProof, token, maxPerSpend, dailyLimit }
}
