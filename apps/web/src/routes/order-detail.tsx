import { Link, useParams } from '@tanstack/react-router'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { StatusTimeline } from '@/components/status-timeline'
import { SettlementFlow, type ResolvedPayout } from '@/components/settlement-flow'
import { ActionsPanel } from '@/components/actions-panel'
import { AuditLog } from '@/components/audit-log'
import { ReconciliationCard } from '@/components/reconciliation-card'
import { OrderStateBadge } from '@/components/order-state-badge'
import { useOrder } from '@/hooks/useOrders'
import { formatMoney, shortenHash } from '@/lib/format'
import { addressUrl, tokenMeta } from '@/lib/contract'
import { ESCROW_ADDRESS } from '@/lib/contract'
import type { AuditEntry } from '@/lib/orders'
import { ArrowLeft, ExternalLink } from 'lucide-react'

function extractResolved(audit: AuditEntry[]): ResolvedPayout | undefined {
  const e = audit.find((a) => a.event === 'DisputeResolved')
  if (!e) return undefined
  return {
    toCustomer: e.args.toCustomer as bigint,
    toMerchant: e.args.toMerchant as bigint,
    toCreator: e.args.toCreator as bigint,
    toPlatform: e.args.toPlatform as bigint,
  }
}

export function OrderDetailPage() {
  const { orderId } = useParams({ from: '/orders/$orderId' })
  const { data, isLoading, isError } = useOrder(orderId as `0x${string}`)

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-muted-foreground">Order not found on-chain yet.</p>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/dashboard">Back to dashboard</Link>
        </Button>
      </div>
    )
  }

  const { order, audit } = data
  const resolved = extractResolved(audit)

  return (
    <div className="space-y-6">
      <Link to="/dashboard" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" /> Dashboard
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{order.productName}</h1>
            <OrderStateBadge state={order.state} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {order.customerCountry} · {formatMoney(order.totalAmount, tokenMeta(order.token).prefix)}{' '}
            <span className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium">
              {tokenMeta(order.token).symbol}
            </span>{' '}
            ·{' '}
            <a
              href={addressUrl(ESCROW_ADDRESS)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:underline"
            >
              order {shortenHash(order.orderId)} <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </div>
      </div>

      {/* Timeline */}
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <StatusTimeline order={order} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Centerpiece */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Settlement</CardTitle>
          </CardHeader>
          <CardContent>
            <SettlementFlow order={order} resolved={resolved} />
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="space-y-6">
          <ActionsPanel order={order} />
        </div>
      </div>

      {/* Reconciliation */}
      <ReconciliationCard order={order} audit={audit} />

      {/* Audit log */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Audit log</CardTitle>
          <p className="text-sm text-muted-foreground">
            Reconstructed entirely from contract events — each row links to the on-chain transaction.
          </p>
        </CardHeader>
        <CardContent>
          <AuditLog entries={audit} />
        </CardContent>
      </Card>
    </div>
  )
}
