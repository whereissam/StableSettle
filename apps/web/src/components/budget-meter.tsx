import { cn } from '@/lib/utils'
import { formatUsd } from '@/lib/format'

type Accent = 'primary' | 'success' | 'warning' | 'danger'

const FILL: Record<Accent, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-reserve',
  danger: 'bg-danger',
}

/** A labelled spend-vs-cap bar. `used`/`total` are 6-decimal token base units. */
export function BudgetMeter({
  label,
  used,
  total,
  accent = 'primary',
  hint,
}: {
  label: string
  used: bigint
  total: bigint
  accent?: Accent
  hint?: string
}) {
  const pct = total > 0n ? Math.min(100, Number((used * 10_000n) / total) / 100) : 0

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular text-muted-foreground">
          <span className="font-medium text-foreground">{formatUsd(used)}</span> / {formatUsd(total)}
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn('h-full rounded-full transition-all', FILL[accent])}
          style={{ width: `${pct}%` }}
        />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
