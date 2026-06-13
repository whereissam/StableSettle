import { Link } from '@tanstack/react-router'
import { StatCard } from '@/components/stat-card'
import { OrderStateBadge } from '@/components/order-state-badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { useOrders } from '@/hooks/useOrders'
import { formatUsd, formatMoney } from '@/lib/format'
import { tokenMeta } from '@/lib/contract'
import { ArrowRight, AlertTriangle } from 'lucide-react'

export function DashboardPage() {
  const { data, isLoading } = useOrders()
  const stats = data?.stats
  const orders = data?.orders ?? []

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Live settlement metrics, aggregated from contract events on Arc.
        </p>
      </div>

      {stats && stats.anomalyCount > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-danger/40 bg-danger/5 p-4 text-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-danger" />
          <span>
            <span className="font-medium text-danger">
              {stats.anomalyCount} order{stats.anomalyCount > 1 ? 's' : ''} flagged for duties review
            </span>{' '}
            — release is blocked until an admin clears the anomaly.
          </span>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Volume settled" value={stats ? formatUsd(stats.volumeSettled) : '—'} hint="Released + resolved" accent="success" />
        <StatCard label="Funds pending" value={stats ? formatUsd(stats.fundsPending) : '—'} hint="In escrow, awaiting release" />
        <StatCard label="Reserves locked" value={stats ? formatUsd(stats.reservesLocked) : '—'} hint="Refund risk buffer" accent="warning" />
        <StatCard label="Disputed" value={stats ? formatUsd(stats.disputedAmount) : '—'} hint="Frozen pending resolution" accent="danger" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Orders</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : orders.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-muted-foreground">No orders yet.</p>
              <Button asChild className="mt-4">
                <Link to="/demo">
                  Seed demo orders <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => (
                  <TableRow key={o.orderId}>
                    <TableCell className="font-medium">{o.productName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{o.customerCountry}</TableCell>
                    <TableCell className="tabular">
                      {formatMoney(o.totalAmount, tokenMeta(o.token).prefix)}
                      <span className="ml-1.5 text-xs text-muted-foreground">{tokenMeta(o.token).symbol}</span>
                    </TableCell>
                    <TableCell>
                      <OrderStateBadge state={o.state} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link to="/orders/$orderId" params={{ orderId: o.orderId }}>
                          View <ArrowRight className="ml-1 h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
