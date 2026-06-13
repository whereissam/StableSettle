import { useAccount } from 'wagmi'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { useEscrowActions } from '@/hooks/useEscrowActions'
import { USDC_IS_MOCK, tokenMeta } from '@/lib/contract'
import { DEMO_ACTUAL_DUTIES, DEMO_RESOLUTION, DEMO_TOTAL } from '@/lib/demo'
import { formatMoney } from '@/lib/format'
import type { OrderSummary } from '@/lib/orders'
import { Coins, PackageCheck, Send, ShieldAlert, Gavel, FileSearch, ShieldCheck } from 'lucide-react'

export function ActionsPanel({ order }: { order: OrderSummary }) {
  const { isConnected } = useAccount()
  const a = useEscrowActions()
  const busy = a.pending !== null
  const { state } = order
  const { prefix, symbol } = tokenMeta(order.token)
  const money = (amt: bigint) => formatMoney(amt, prefix)

  if (!isConnected) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Connect your wallet to act on this order.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {USDC_IS_MOCK && (
          <>
            <Button
              variant="outline"
              className="w-full justify-start"
              disabled={busy}
              onClick={() => a.mint(DEMO_TOTAL, order.token)}
            >
              <Coins className="mr-2 h-4 w-4" />
              Mint {money(DEMO_TOTAL)} test {symbol}
            </Button>
            <Separator />
          </>
        )}

        {state === 'Created' && (
          <Button
            className="w-full justify-start"
            disabled={busy}
            onClick={() => a.approveAndFund(order.orderId, order.token)}
          >
            <Send className="mr-2 h-4 w-4" />
            Approve &amp; fund {money(order.totalAmount)}
          </Button>
        )}

        {state === 'Funded' && (
          <Button className="w-full justify-start" disabled={busy} onClick={() => a.markDelivered(order.orderId)}>
            <PackageCheck className="mr-2 h-4 w-4" />
            Mark delivered <span className="ml-1 text-xs opacity-70">(oracle · simulated)</span>
          </Button>
        )}

        {state === 'Delivered' && order.estimatedDuties > 0n && order.actualDuties === 0n && (
          <Button
            variant="outline"
            className="w-full justify-start"
            disabled={busy}
            onClick={() => a.reportActualDuties(order.orderId, DEMO_ACTUAL_DUTIES)}
          >
            <FileSearch className="mr-2 h-4 w-4" />
            Report actual duties {money(DEMO_ACTUAL_DUTIES)} <span className="ml-1 text-xs opacity-70">(oracle · simulated)</span>
          </Button>
        )}

        {state === 'Delivered' && order.anomalyFlagged && (
          <>
            <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
              Duties came in at {money(order.actualDuties)} vs. {money(order.estimatedDuties)} estimated —
              release is blocked pending review.
            </p>
            <Button className="w-full justify-start" disabled={busy} onClick={() => a.clearAnomaly(order.orderId)}>
              <ShieldCheck className="mr-2 h-4 w-4" />
              Clear anomaly (admin review)
            </Button>
          </>
        )}

        {state === 'Delivered' && !order.anomalyFlagged && (
          <Button className="w-full justify-start" disabled={busy} onClick={() => a.release(order.orderId)}>
            <Send className="mr-2 h-4 w-4" />
            Release funds
          </Button>
        )}

        {(state === 'Funded' || state === 'Delivered') && (
          <Button
            variant="destructive"
            className="w-full justify-start"
            disabled={busy}
            onClick={() => a.raiseDispute(order.orderId)}
          >
            <ShieldAlert className="mr-2 h-4 w-4" />
            Raise dispute (refuse package)
          </Button>
        )}

        {state === 'Disputed' && (
          <Button
            className="w-full justify-start"
            disabled={busy}
            onClick={() => a.resolveDispute(order.orderId, DEMO_RESOLUTION)}
          >
            <Gavel className="mr-2 h-4 w-4" />
            Resolve: {money(DEMO_RESOLUTION.toCustomer)} refund / {money(DEMO_RESOLUTION.toMerchant)} merchant
          </Button>
        )}

        {(state === 'Released' || state === 'Resolved') && (
          <p className="text-sm text-muted-foreground">
            This order is fully settled. The audit log below is the finalized record.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
