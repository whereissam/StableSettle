import { hc } from 'hono/client'
import type { AppType } from '@stablesettle/api/app'
import type { OrderDTO, AuditEntryDTO } from '@stablesettle/shared'
import type { OrderSummary, AuditEntry, AuditEventName } from './orders'
import { stateName, USDC_ADDRESS } from './contract'

/**
 * Optional backend. Set VITE_API_URL to read orders/audit log from the Hono API + Postgres
 * indexer instead of directly from chain. Unset → the app reads contract events directly.
 */
export const API_URL = import.meta.env.VITE_API_URL as string | undefined
export const apiEnabled = !!API_URL

export const api = API_URL ? hc<AppType>(API_URL) : null

/** Map an API order DTO back into the bigint-based shape the UI components expect. */
export function dtoToOrderSummary(o: OrderDTO): OrderSummary {
  return {
    orderId: o.orderId as `0x${string}`,
    productName: o.productName || 'Order',
    customerCountry: o.customerCountry,
    totalAmount: BigInt(o.totalAmount),
    refundWindowSeconds: BigInt(o.refundWindowSeconds),
    deliveredAt: BigInt(o.deliveredAt),
    estimatedDuties: BigInt(o.estimatedDuties),
    actualDuties: BigInt(o.actualDuties),
    anomalyFlagged: o.anomalyFlagged,
    token: (o.token || USDC_ADDRESS) as `0x${string}`,
    state: o.state,
    stateIndex: o.stateIndex,
    settled: o.settled,
    parties: {
      merchant: o.merchant as `0x${string}`,
      creator: o.creator as `0x${string}`,
      platform: o.platform as `0x${string}`,
      customer: o.customer as `0x${string}`,
    },
    buckets: {
      merchant: BigInt(o.merchantAmount),
      refundReserve: BigInt(o.refundReserve),
      creator: BigInt(o.creatorCommission),
      platform: BigInt(o.platformFee),
    },
  }
}

/** Decimal-string arg values → bigint (matching what the chain path produces); leave the rest. */
function reviveArgs(args: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : v
  }
  return out
}

export function dtoToAuditEntry(e: AuditEntryDTO): AuditEntry {
  return {
    event: e.event as AuditEventName,
    blockNumber: BigInt(e.blockNumber),
    txHash: e.txHash as `0x${string}`,
    logIndex: e.logIndex,
    args: reviveArgs(e.args),
  }
}

// `stateName` is re-exported so callers mapping raw indexes have it alongside the client.
export { stateName }
