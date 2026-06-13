import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { formatMoney } from '@/lib/format'
import { tokenMeta } from '@/lib/contract'
import { computeReconciliation } from '@/lib/reconciliation'
import type { OrderSummary, AuditEntry } from '@/lib/orders'

function signedMoney(delta: bigint, prefix: '$' | '€'): string {
  if (delta === 0n) return '—'
  const sign = delta > 0n ? '+' : '-'
  const abs = delta > 0n ? delta : -delta
  return `${sign}${formatMoney(abs, prefix)}`
}

export function ReconciliationCard({
  order,
  audit,
}: {
  order: OrderSummary
  audit: AuditEntry[]
}) {
  const r = computeReconciliation(order, audit)
  const anomalous = r.dutiesVarianceRatio !== null && r.dutiesVarianceRatio > 2
  const { prefix } = tokenMeta(order.token)
  const money = (a: bigint) => formatMoney(a, prefix)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Reconciliation</CardTitle>
          {r.settled ? (
            r.mismatch ? (
              <Badge variant="destructive">Variance</Badge>
            ) : (
              <Badge className="bg-success/15 text-success hover:bg-success/15">Clean</Badge>
            )
          ) : (
            <Badge variant="secondary">Awaiting settlement</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Estimated vs. actual — duties and per-party payouts, reconciled from contract events.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Duties */}
        {r.dutiesTracked && (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Duties estimated" value={money(r.estimatedDuties)} />
            <Field
              label="Duties actual"
              value={r.actualDuties > 0n ? money(r.actualDuties) : 'Not reported'}
            />
            <Field
              label="Variance"
              value={r.dutiesVarianceRatio !== null ? `${r.dutiesVarianceRatio.toFixed(1)}×` : '—'}
              danger={anomalous}
              hint={anomalous ? 'over 2× — flagged' : undefined}
            />
          </div>
        )}

        {/* Payouts */}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Recipient</TableHead>
              <TableHead className="text-right">Expected</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Δ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.rows.map((row) => {
              const delta = row.actual !== null ? row.actual - row.expected : 0n
              const mismatched = row.actual !== null && row.actual !== row.expected
              return (
                <TableRow key={row.recipient} className={cn(mismatched && 'bg-danger/5')}>
                  <TableCell className="font-medium">{row.recipient}</TableCell>
                  <TableCell className="text-right tabular">{money(row.expected)}</TableCell>
                  <TableCell className="text-right tabular">
                    {row.actual !== null ? money(row.actual) : '—'}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular',
                      mismatched ? 'font-medium text-danger' : 'text-muted-foreground',
                    )}
                  >
                    {row.actual !== null ? signedMoney(delta, prefix) : '—'}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>

        {r.settled && r.mismatch && (
          <p className="text-xs text-muted-foreground">
            Payouts differ from the original split (a dispute resolution or refund) — this is the
            reconciliation record a finance team would review. Value is still conserved: actual
            payouts sum to the order total.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function Field({
  label,
  value,
  danger,
  hint,
}: {
  label: string
  value: string
  danger?: boolean
  hint?: string
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-lg font-semibold tabular', danger && 'text-danger')}>{value}</p>
      {hint && <p className="text-[11px] text-danger">{hint}</p>}
    </div>
  )
}
