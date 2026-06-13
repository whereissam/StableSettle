import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useAccount, usePublicClient } from 'wagmi'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { OrderStateBadge } from '@/components/order-state-badge'
import { useEscrowActions } from '@/hooks/useEscrowActions'
import { useOrders } from '@/hooks/useOrders'
import {
  makeDemoOrders,
  type DemoOrderTemplate,
  DEMO_RESOLUTION,
  DEMO_TOTAL,
  DEMO_ACTUAL_DUTIES,
} from '@/lib/demo'
import { escrowAbi, ESCROW_ADDRESS, stateName, isConfigured, tokenMeta, USDC_IS_MOCK } from '@/lib/contract'
import { formatMoney } from '@/lib/format'
import type { OrderSummary } from '@/lib/orders'
import { ArrowRight, RotateCcw, PlayCircle, CheckCircle2 } from 'lucide-react'

const SUFFIX_KEY = 'stablesettle-demo-suffix'

function useSuffix() {
  const [suffix, setSuffix] = useState(() => localStorage.getItem(SUFFIX_KEY) ?? 'v1')
  const reset = () => {
    const next = `v${Date.now()}`
    localStorage.setItem(SUFFIX_KEY, next)
    setSuffix(next)
  }
  return { suffix, reset }
}

export function DemoPage() {
  const { isConnected } = useAccount()
  const { suffix, reset } = useSuffix()
  const orders = makeDemoOrders(suffix)
  const { data } = useOrders()

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Demo mode</h1>
          <p className="text-sm text-muted-foreground">
            Step through all three scenarios. Each step is a real transaction on Arc — watch the
            settlement animate on the order detail page.
          </p>
        </div>
        <Button variant="outline" onClick={reset} className="shrink-0 self-start">
          <RotateCcw className="mr-2 h-4 w-4" /> Reset demo
        </Button>
      </div>

      {!isConfigured && (
        <p className="rounded-lg border bg-accent p-4 text-sm text-accent-foreground">
          Deploy the contract first — see the README. The buttons need a configured escrow address.
        </p>
      )}
      {!isConnected && (
        <p className="rounded-lg border bg-secondary p-4 text-sm text-muted-foreground">
          Connect your wallet (top right) to run the demo.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {orders.map((tpl) => (
          <ScenarioCard
            key={tpl.id}
            template={tpl}
            order={data?.orders.find((o) => o.orderId === tpl.id)}
          />
        ))}
      </div>
    </div>
  )
}

const SCENARIO_STEPS: Record<'A' | 'B' | 'C', string[]> = {
  A: ['Create order', 'Approve & fund', 'Mark delivered', 'Release funds'],
  B: ['Create order', 'Approve & fund', 'Raise dispute', 'Resolve dispute'],
  C: ['Create order', 'Approve & fund', 'Mark delivered', 'Report duties', 'Clear anomaly', 'Release funds'],
}

function ScenarioCard({
  template,
  order,
}: {
  template: DemoOrderTemplate
  order?: OrderSummary
}) {
  const a = useEscrowActions()
  const client = usePublicClient()
  const { isConnected } = useAccount()
  const [running, setRunning] = useState(false)
  const busy = a.pending !== null || running

  const stateIdx = order?.stateIndex ?? -1 // -1 = not created
  const steps = SCENARIO_STEPS[template.scenario]
  // Map on-chain state to "completed step count".
  const done = completedSteps(template.scenario, order)
  const isComplete = order?.state === 'Released' || order?.state === 'Resolved'

  /** Execute the single next step for this scenario based on current state. */
  async function runNext() {
    setRunning(true)
    try {
      await execNext(template, order, a)
    } finally {
      setRunning(false)
    }
  }

  /** Auto-run all remaining steps, re-reading on-chain state between each. */
  async function runAll() {
    setRunning(true)
    try {
      let cur = order
      // Ensure the customer has funds in mock mode.
      for (let i = 0; i < steps.length; i++) {
        const advanced = await execNext(template, cur, a)
        if (!advanced) break
        cur = await refetchOrder(client!, template.id)
        if (cur?.state === 'Released' || cur?.state === 'Resolved') break
      }
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            Scenario {template.scenario} — {template.label}
          </CardTitle>
          {order ? <OrderStateBadge state={order.state} /> : <span className="text-xs text-muted-foreground">Not created</span>}
        </div>
        <p className="text-sm text-muted-foreground">
          {template.productName} · {template.customerCountry} ·{' '}
          {formatMoney(DEMO_TOTAL, tokenMeta(template.token).prefix)} · {tokenMeta(template.token).symbol}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="space-y-2">
          {steps.map((label, i) => {
            const complete = i < done
            const current = i === done && !isComplete
            return (
              <li key={label} className="flex items-center gap-3 text-sm">
                <span
                  className={
                    complete
                      ? 'text-success'
                      : current
                        ? 'font-medium text-foreground'
                        : 'text-muted-foreground'
                  }
                >
                  {complete ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full border text-[10px]">
                      {i + 1}
                    </span>
                  )}
                </span>
                <span className={complete ? 'text-muted-foreground line-through' : current ? 'font-medium' : 'text-muted-foreground'}>
                  {label}
                </span>
                {template.scenario === 'B' && i === 3 && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    $70 / $25 / $5
                  </span>
                )}
              </li>
            )
          })}
        </ol>

        <Separator />

        <div className="flex flex-wrap gap-2">
          <Button onClick={runNext} disabled={!isConnected || busy || isComplete}>
            <ArrowRight className="mr-2 h-4 w-4" />
            {isComplete ? 'Complete' : `Next: ${steps[done]}`}
          </Button>
          <Button variant="outline" onClick={runAll} disabled={!isConnected || busy || isComplete}>
            <PlayCircle className="mr-2 h-4 w-4" /> Auto-run
          </Button>
          {order && (
            <Button asChild variant="ghost">
              <Link to="/orders/$orderId" params={{ orderId: order.orderId }}>
                Watch settlement <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Step {stateIdx + 1 < 0 ? 0 : done} of {steps.length}. The “delivered” signal is a
          simulated oracle action.
        </p>
      </CardContent>
    </Card>
  )
}

/** How many steps are visibly complete for the given scenario + order state. */
function completedSteps(scenario: 'A' | 'B' | 'C', order?: OrderSummary): number {
  if (!order) return 0
  if (scenario === 'A') {
    switch (order.state) {
      case 'Created':
        return 1
      case 'Funded':
        return 2
      case 'Delivered':
        return 3
      case 'Released':
        return 4
      default:
        return 2
    }
  }
  if (scenario === 'C') {
    switch (order.state) {
      case 'Created':
        return 1
      case 'Funded':
        return 2
      case 'Delivered':
        if (order.actualDuties === 0n) return 3 // duties not yet reported
        if (order.anomalyFlagged) return 4 // reported & flagged — needs clearing
        return 5 // cleared (or no flag) — needs release
      case 'Released':
        return 6
      default:
        return 2
    }
  }
  // Scenario B
  switch (order.state) {
    case 'Created':
      return 1
    case 'Funded':
    case 'Delivered':
      return 2
    case 'Disputed':
      return 3
    case 'Resolved':
      return 4
    default:
      return 1
  }
}

/** Run the appropriate next on-chain action. Returns true if an action was sent. */
async function execNext(
  tpl: DemoOrderTemplate,
  order: OrderSummary | undefined,
  a: ReturnType<typeof useEscrowActions>,
): Promise<boolean> {
  // Make sure there are funds to pay with (mock mode top-up is a no-op on real USDC).
  if (!order) {
    await a.createOrder({
      orderId: tpl.id,
      productName: tpl.productName,
      customerCountry: tpl.customerCountry,
      estimatedDuties: tpl.estimatedDuties,
      token: tpl.token,
    })
    return true
  }
  switch (order.state) {
    case 'Created': {
      // Only mint in mock mode — real Arc USDC (NativeFiatToken) has no public mint, so a mint tx
      // would just revert on-chain. With real USDC the connected wallet must already hold funds.
      if (USDC_IS_MOCK) {
        const bal = await a.getBalance(tpl.token)
        if (bal < DEMO_TOTAL) await a.mint(DEMO_TOTAL, tpl.token)
      } else {
        const bal = await a.getBalance(tpl.token)
        if (bal < DEMO_TOTAL) {
          throw new Error(
            `Wallet holds ${bal / 1_000000n} ${tokenMeta(tpl.token).symbol}, need ${DEMO_TOTAL / 1_000000n}. ` +
              `Using real Arc USDC — fund this wallet at https://faucet.circle.com, or redeploy with MockUSDC.`,
          )
        }
      }
      await a.approveAndFund(tpl.id, tpl.token)
      return true
    }
    case 'Funded':
      // Scenario C and A both go through delivery; B disputes from Funded.
      if (tpl.scenario === 'B') await a.raiseDispute(tpl.id)
      else await a.markDelivered(tpl.id)
      return true
    case 'Delivered':
      if (tpl.scenario === 'A') {
        await a.release(tpl.id)
      } else if (tpl.scenario === 'B') {
        await a.raiseDispute(tpl.id)
      } else {
        // Scenario C: report duties → (auto-flag) → clear → release.
        if (order.actualDuties === 0n) await a.reportActualDuties(tpl.id, DEMO_ACTUAL_DUTIES)
        else if (order.anomalyFlagged) await a.clearAnomaly(tpl.id)
        else await a.release(tpl.id)
      }
      return true
    case 'Disputed':
      await a.resolveDispute(tpl.id, DEMO_RESOLUTION)
      return true
    default:
      return false
  }
}

/** Read the live order state for the auto-run loop. */
async function refetchOrder(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  orderId: `0x${string}`,
): Promise<OrderSummary | undefined> {
  try {
    const o = (await client.readContract({
      address: ESCROW_ADDRESS,
      abi: escrowAbi,
      functionName: 'getOrder',
      args: [orderId],
    })) as { state: number; actualDuties: bigint; anomalyFlagged: boolean }
    return {
      state: stateName(o.state),
      stateIndex: o.state,
      actualDuties: o.actualDuties,
      anomalyFlagged: o.anomalyFlagged,
    } as OrderSummary
  } catch {
    return undefined
  }
}
