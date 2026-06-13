import type { AuditEventName, OrderState } from './states'

/** All on-chain amounts cross the API as decimal strings (bigint-safe in JSON). */

export interface OrderDTO {
  orderId: string
  productName: string
  customerCountry: string
  note: string | null
  totalAmount: string
  refundWindowSeconds: string
  estimatedDuties: string
  actualDuties: string
  deliveredAt: string
  anomalyFlagged: boolean
  settled: boolean
  token: string
  state: OrderState
  stateIndex: number
  merchant: string
  creator: string
  platform: string
  customer: string
  merchantAmount: string
  refundReserve: string
  creatorCommission: string
  platformFee: string
  createdBlock: string
  updatedAt: string
}

export interface AuditEntryDTO {
  event: AuditEventName
  blockNumber: string
  txHash: string
  logIndex: number
  args: Record<string, string | boolean>
  timestamp: string | null
}

export interface DashboardStatsDTO {
  volumeSettled: string
  fundsPending: string
  reservesLocked: string
  disputedAmount: string
  anomalyCount: number
  orderCount: number
}

export interface ReconciliationDTO {
  orderId: string
  estimatedDuties: string
  actualDuties: string
  dutiesVarianceRatio: number | null // actual / estimated
  expectedPayout: Record<string, string> // bucket -> amount the order planned
  actualPayout: Record<string, string> // recipient -> amount actually paid (once settled)
  mismatch: boolean
  computedAt: string
}

export interface IndexerStatusDTO {
  lastBlock: string
  chainId: number
  escrow: string
  healthy: boolean
}
