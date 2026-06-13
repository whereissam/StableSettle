import { Check, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OrderSummary } from '@/lib/orders'

interface Step {
  name: string
  reached: boolean
  current: boolean
  danger?: boolean
}

/** Build the step list, choosing the happy path or the dispute branch. */
function buildSteps(order: OrderSummary): Step[] {
  const idx = order.stateIndex
  const disputeBranch = order.state === 'Disputed' || order.state === 'Resolved'
  const wentThroughDelivered = order.deliveredAt > 0n

  if (disputeBranch) {
    const names = ['Created', 'Funded']
    if (wentThroughDelivered) names.push('Delivered')
    names.push('Disputed', 'Resolved')
    const resolved = order.state === 'Resolved'
    return names.map((name) => {
      if (name === 'Disputed')
        return { name, reached: true, current: order.state === 'Disputed', danger: true }
      if (name === 'Resolved')
        return { name, reached: resolved, current: resolved }
      return { name, reached: true, current: false }
    })
  }

  // Happy path: Created → Funded → Delivered → Released
  const names = ['Created', 'Funded', 'Delivered', 'Released']
  return names.map((name, i) => ({
    name,
    reached: i <= idx,
    current: i === idx,
  }))
}

export function StatusTimeline({ order }: { order: OrderSummary }) {
  const steps = buildSteps(order)

  return (
    <div className="flex min-w-[480px] items-center sm:min-w-0">
      {steps.map((step, i) => (
        <div key={step.name} className="flex flex-1 items-center last:flex-none">
          <div className="flex flex-col items-center gap-2">
            <div
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors',
                step.danger && step.reached
                  ? 'border-danger bg-danger text-white'
                  : step.reached
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground',
                step.current && 'ring-4 ring-primary/15',
                step.current && step.danger && 'ring-danger/20',
              )}
            >
              {step.danger && step.reached ? (
                <AlertTriangle className="h-4 w-4" />
              ) : step.reached ? (
                <Check className="h-4 w-4" />
              ) : (
                i + 1
              )}
            </div>
            <span
              className={cn(
                'text-xs font-medium',
                step.reached ? 'text-foreground' : 'text-muted-foreground',
                step.danger && step.reached && 'text-danger',
              )}
            >
              {step.name}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div
              className={cn(
                'mx-2 h-0.5 flex-1 rounded transition-colors',
                steps[i + 1].reached
                  ? steps[i + 1].danger
                    ? 'bg-danger'
                    : 'bg-primary'
                  : 'bg-border',
              )}
            />
          )}
        </div>
      ))}
    </div>
  )
}
