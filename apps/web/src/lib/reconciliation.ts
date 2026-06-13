import type { OrderSummary, AuditEntry } from './orders'

export interface PayoutRow {
  recipient: 'Customer' | 'Merchant' | 'Creator' | 'Platform'
  expected: bigint
  actual: bigint | null // null until settled
}

export interface Reconciliation {
  estimatedDuties: bigint
  actualDuties: bigint
  dutiesTracked: boolean
  dutiesVarianceRatio: number | null // actual / estimated
  rows: PayoutRow[]
  settled: boolean
  mismatch: boolean
}

/**
 * Compute the per-order reconciliation entirely from the order struct + its event log —
 * the same logic the backend indexer runs, so the view works with or without the API.
 *
 * Expected payout = what a clean release pays each party (the refund reserve returns to the
 * customer). Actual payout is read from the settlement event (Released or DisputeResolved).
 */
export function computeReconciliation(order: OrderSummary, audit: AuditEntry[]): Reconciliation {
  const expected: Record<PayoutRow['recipient'], bigint> = {
    Customer: order.buckets.refundReserve,
    Merchant: order.buckets.merchant,
    Creator: order.buckets.creator,
    Platform: order.buckets.platform,
  }

  let actual: Record<PayoutRow['recipient'], bigint> | null = null
  for (const e of audit) {
    if (e.event === 'Released') {
      actual = {
        Customer: e.args.refundReserve as bigint,
        Merchant: e.args.merchantAmount as bigint,
        Creator: e.args.creatorCommission as bigint,
        Platform: e.args.platformFee as bigint,
      }
    } else if (e.event === 'DisputeResolved') {
      actual = {
        Customer: e.args.toCustomer as bigint,
        Merchant: e.args.toMerchant as bigint,
        Creator: e.args.toCreator as bigint,
        Platform: e.args.toPlatform as bigint,
      }
    }
  }

  const recipients: PayoutRow['recipient'][] = ['Customer', 'Merchant', 'Creator', 'Platform']
  const rows: PayoutRow[] = recipients.map((r) => ({
    recipient: r,
    expected: expected[r],
    actual: actual ? actual[r] : null,
  }))

  const settled = actual !== null
  const mismatch = settled && rows.some((r) => r.actual !== r.expected)

  const dutiesTracked = order.estimatedDuties > 0n
  const dutiesVarianceRatio =
    dutiesTracked && order.actualDuties > 0n
      ? Number(order.actualDuties) / Number(order.estimatedDuties)
      : null

  return {
    estimatedDuties: order.estimatedDuties,
    actualDuties: order.actualDuties,
    dutiesTracked,
    dutiesVarianceRatio,
    rows,
    settled,
    mismatch,
  }
}
