import type { Abi, Address } from 'viem'
import escrowAbiJson from './abi/StableSettleEscrow.json'
import erc20AbiJson from './abi/erc20.json'
import deployments from '../deployments.json'

export const escrowAbi = escrowAbiJson as Abi
export const erc20Abi = erc20AbiJson as Abi

/**
 * Resolved contract addresses. Env vars (VITE_ESCROW_ADDRESS / VITE_USDC_ADDRESS)
 * win over the generated deployments.json so you can repoint without redeploying.
 * A *blank* env var (e.g. `VITE_ESCROW_ADDRESS=` in .env) counts as unset — otherwise
 * `??` keeps the "" and viem throws `Address "" is invalid`.
 */
function envAddress(value: string | undefined, fallback: string): Address {
  return (value && value.trim().length > 0 ? value : fallback) as Address
}

export const ESCROW_ADDRESS = envAddress(import.meta.env.VITE_ESCROW_ADDRESS, deployments.escrow)
export const USDC_ADDRESS = envAddress(import.meta.env.VITE_USDC_ADDRESS, deployments.usdc)
export const EURC_ADDRESS = envAddress(import.meta.env.VITE_EURC_ADDRESS, deployments.eurc)

export const USDC_IS_MOCK = deployments.usdcIsMock as boolean

/** Currency metadata for the two supported settlement tokens (both 6-decimal). */
export interface TokenMeta {
  symbol: 'USDC' | 'EURC'
  prefix: '$' | '€'
  address: Address
}

export function tokenMeta(address?: string): TokenMeta {
  if (address && address.toLowerCase() === EURC_ADDRESS.toLowerCase()) {
    return { symbol: 'EURC', prefix: '€', address: EURC_ADDRESS }
  }
  return { symbol: 'USDC', prefix: '$', address: USDC_ADDRESS }
}
export const DEPLOYMENT_CHAIN_ID = deployments.chainId as number

export const ARC_EXPLORER = 'https://testnet.arcscan.app'

export function txUrl(hash: string): string {
  return `${ARC_EXPLORER}/tx/${hash}`
}

export function addressUrl(address: string): string {
  return `${ARC_EXPLORER}/address/${address}`
}

/** True once a real escrow address has been deployed and wired in. */
export const isConfigured =
  ESCROW_ADDRESS !== '0x0000000000000000000000000000000000000000'

/** The six on-chain order states, indexed to match the Solidity enum. */
export const ORDER_STATES = [
  'Created',
  'Funded',
  'Delivered',
  'Released',
  'Disputed',
  'Resolved',
] as const

export type OrderState = (typeof ORDER_STATES)[number]

export function stateName(state: number): OrderState {
  return ORDER_STATES[state] ?? 'Created'
}

/** Roles, keccak256 of the role name — must match the contract. */
export const ROLES = {
  MERCHANT_ROLE: 'MERCHANT_ROLE',
  ORACLE_ROLE: 'ORACLE_ROLE',
  ADMIN_ROLE: 'ADMIN_ROLE',
} as const
