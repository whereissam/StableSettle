import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: string
  hint?: string
  accent?: 'default' | 'warning' | 'danger' | 'success'
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <p
          className={cn(
            'mt-2 text-3xl font-semibold tabular tracking-tight',
            accent === 'warning' && 'text-reserve',
            accent === 'danger' && 'text-danger',
            accent === 'success' && 'text-success',
          )}
        >
          {value}
        </p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}
