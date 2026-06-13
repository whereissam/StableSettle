import { Badge } from '@/components/ui/badge'
import type { OrderState } from '@/lib/contract'

const VARIANT: Record<OrderState, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  Created: 'outline',
  Funded: 'secondary',
  Delivered: 'secondary',
  Released: 'default',
  Disputed: 'destructive',
  Resolved: 'default',
}

export function OrderStateBadge({ state }: { state: OrderState }) {
  return <Badge variant={VARIANT[state]}>{state}</Badge>
}
