import type { Address } from 'viem'
import deployments from '../../web/src/deployments.json' with { type: 'json' }

export const RPC_URL = process.env.ARC_TESTNET_RPC_URL ?? 'https://rpc.testnet.arc.network'

/** Escrow address: env wins, else the generated deployments.json. */
export const ESCROW_ADDRESS = (process.env.ESCROW_ADDRESS ?? deployments.escrow) as Address

export const CHAIN_ID = deployments.chainId as number

export const DEPLOY_BLOCK = (() => {
  try {
    return BigInt(process.env.DEPLOY_BLOCK ?? '0')
  } catch {
    return 0n
  }
})()

export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 4000)

export const isConfigured =
  ESCROW_ADDRESS !== '0x0000000000000000000000000000000000000000'
