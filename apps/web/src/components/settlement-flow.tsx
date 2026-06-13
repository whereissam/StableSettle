import { motion, AnimatePresence } from 'framer-motion'
import { Lock, ArrowDownToLine, Check, Snowflake, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatMoney, shortenAddress } from '@/lib/format'
import { tokenMeta } from '@/lib/contract'
import type { OrderSummary } from '@/lib/orders'

export interface ResolvedPayout {
  toCustomer: bigint
  toMerchant: bigint
  toCreator: bigint
  toPlatform: bigint
}

type BucketColor = 'merchant' | 'reserve' | 'creator' | 'platform'

interface BucketView {
  label: string
  color: BucketColor
  amount: bigint
  recipientLabel: string
  recipient: string
  // Visual status for this bucket given the order state.
  status: 'planned' | 'inEscrow' | 'locked' | 'paid' | 'refunded' | 'frozen'
}

const COLOR_CLASS: Record<BucketColor, { bar: string; text: string; ring: string }> = {
  merchant: { bar: 'bg-merchant', text: 'text-merchant', ring: 'ring-merchant/30' },
  reserve: { bar: 'bg-reserve', text: 'text-reserve', ring: 'ring-reserve/30' },
  creator: { bar: 'bg-creator', text: 'text-creator', ring: 'ring-creator/30' },
  platform: { bar: 'bg-platform', text: 'text-platform', ring: 'ring-platform/30' },
}

const STATUS_LABEL: Record<BucketView['status'], string> = {
  planned: 'Planned',
  inEscrow: 'In escrow',
  locked: 'Locked',
  paid: 'Paid',
  refunded: 'Refunded',
  frozen: 'Frozen',
}

function buildBuckets(order: OrderSummary, resolved?: ResolvedPayout): BucketView[] {
  const s = order.state
  const funded = s !== 'Created'
  const released = s === 'Released'
  const disputed = s === 'Disputed'
  const resolvedState = s === 'Resolved'
  const p = order.parties

  // In the resolved state the payout is recipient-based, not bucket-based.
  if (resolvedState && resolved) {
    return [
      { label: 'Refund to customer', color: 'reserve', amount: resolved.toCustomer, recipientLabel: 'Customer', recipient: p.customer, status: 'refunded' },
      { label: 'Merchant', color: 'merchant', amount: resolved.toMerchant, recipientLabel: 'Merchant', recipient: p.merchant, status: 'paid' },
      { label: 'Creator', color: 'creator', amount: resolved.toCreator, recipientLabel: 'Creator', recipient: p.creator, status: 'paid' },
      { label: 'Platform', color: 'platform', amount: resolved.toPlatform, recipientLabel: 'Platform', recipient: p.platform, status: 'paid' },
    ]
  }

  const base = (): BucketView['status'] => {
    if (!funded) return 'planned'
    if (disputed) return 'frozen'
    if (released) return 'paid'
    return 'inEscrow'
  }

  return [
    {
      label: 'Merchant',
      color: 'merchant',
      amount: order.buckets.merchant,
      recipientLabel: 'Merchant',
      recipient: p.merchant,
      status: base(),
    },
    {
      label: 'Refund reserve',
      color: 'reserve',
      amount: order.buckets.refundReserve,
      recipientLabel: released ? 'Returned to customer' : 'Held in reserve',
      recipient: p.customer,
      // The reserve is the cross-border story: locked while funded, frozen on dispute, refunded on release.
      status: !funded ? 'planned' : disputed ? 'frozen' : released ? 'refunded' : 'locked',
    },
    {
      label: 'Creator',
      color: 'creator',
      amount: order.buckets.creator,
      recipientLabel: 'Creator',
      recipient: p.creator,
      status: base(),
    },
    {
      label: 'Platform',
      color: 'platform',
      amount: order.buckets.platform,
      recipientLabel: 'Platform',
      recipient: p.platform,
      status: base(),
    },
  ]
}

export function SettlementFlow({
  order,
  resolved,
}: {
  order: OrderSummary
  resolved?: ResolvedPayout
}) {
  const buckets = buildBuckets(order, resolved)
  const funded = order.state !== 'Created'
  const { prefix, symbol } = tokenMeta(order.token)
  const money = (amount: bigint) => formatMoney(amount, prefix)

  return (
    <div className="space-y-6">
      {/* Source node */}
      <div className="flex flex-col items-center">
        <motion.div
          layout
          className={cn(
            'rounded-xl border bg-card px-8 py-4 text-center shadow-sm',
            funded && 'ring-4 ring-primary/10',
          )}
        >
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Order total · {symbol}
          </p>
          <p className="text-3xl font-semibold tabular tracking-tight">{money(order.totalAmount)}</p>
        </motion.div>
        <motion.div
          className="flex items-center gap-1 py-2 text-xs font-medium text-muted-foreground"
          initial={false}
          animate={{ opacity: funded ? 1 : 0.4 }}
        >
          <ArrowDownToLine className="h-3.5 w-3.5" />
          {funded ? 'Split into four buckets on funding' : 'Splits on funding'}
        </motion.div>
      </div>

      {/* Duties anomaly callout — blocks release until reviewed */}
      <AnimatePresence>
        {order.anomalyFlagged && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-3 rounded-xl border border-danger/40 bg-danger/5 p-4"
          >
            <AlertTriangle className="h-5 w-5 shrink-0 text-danger" />
            <div className="text-sm">
              <p className="font-medium text-danger">Duties anomaly — release blocked</p>
              <p className="text-muted-foreground">
                Customs charged {money(order.actualDuties)} vs. {money(order.estimatedDuties)} estimated
                ({(Number(order.actualDuties) / Math.max(Number(order.estimatedDuties), 1)).toFixed(1)}×). Flagged for
                manual review; an admin must clear it before funds can release.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Buckets */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {buckets.map((b, i) => {
          const colors = COLOR_CLASS[b.color]
          const frozen = b.status === 'frozen'
          const paid = b.status === 'paid' || b.status === 'refunded'
          const locked = b.status === 'locked'
          return (
            <motion.div
              key={b.label}
              layout
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: funded ? 1 : 0.45, y: 0 }}
              transition={{ delay: funded ? i * 0.08 : 0, type: 'spring', stiffness: 200, damping: 22 }}
              className={cn(
                'relative overflow-hidden rounded-xl border bg-card p-4 shadow-sm transition-colors',
                frozen && 'border-danger/50 bg-danger/5 ring-2 ring-danger/20',
                locked && `ring-2 ${colors.ring}`,
              )}
            >
              {/* color bar */}
              <div className={cn('absolute inset-x-0 top-0 h-1', frozen ? 'bg-danger' : colors.bar)} />

              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{b.label}</span>
                <StatusChip status={b.status} />
              </div>

              <p className={cn('mt-2 text-2xl font-semibold tabular', frozen && 'text-danger')}>
                {money(b.amount)}
              </p>

              <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <AnimatePresence mode="wait">
                  {frozen ? (
                    <motion.span key="frozen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-1 text-danger">
                      <Snowflake className="h-3.5 w-3.5" /> Frozen pending dispute
                    </motion.span>
                  ) : paid ? (
                    <motion.span key="paid" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-1 text-success">
                      <Check className="h-3.5 w-3.5" /> {b.recipientLabel} · {shortenAddress(b.recipient)}
                    </motion.span>
                  ) : locked ? (
                    <motion.span key="locked" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-1">
                      <Lock className="h-3.5 w-3.5" /> {b.recipientLabel}
                    </motion.span>
                  ) : (
                    <span>{b.recipientLabel} · {shortenAddress(b.recipient)}</span>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

function StatusChip({ status }: { status: BucketView['status'] }) {
  const styles: Record<BucketView['status'], string> = {
    planned: 'bg-secondary text-muted-foreground',
    inEscrow: 'bg-secondary text-foreground',
    locked: 'bg-reserve/15 text-reserve',
    paid: 'bg-success/15 text-success',
    refunded: 'bg-success/15 text-success',
    frozen: 'bg-danger/15 text-danger',
  }
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', styles[status])}>
      {STATUS_LABEL[status]}
    </span>
  )
}
