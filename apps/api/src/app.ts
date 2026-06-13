import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { eq, asc, desc } from 'drizzle-orm'
import {
  stateName,
  orderMetadataSchema,
  HELD_STATES,
  type OrderDTO,
  type AuditEntryDTO,
  type DashboardStatsDTO,
  type ReconciliationDTO,
  type IndexerStatusDTO,
  type AuditEventName,
} from '@stablesettle/shared'
import { db, schema } from './db'

type OrderRow = typeof schema.orders.$inferSelect
type EventRow = typeof schema.events.$inferSelect

function toOrderDTO(o: OrderRow): OrderDTO {
  return {
    orderId: o.orderId,
    productName: o.productName,
    customerCountry: o.customerCountry,
    note: o.note,
    totalAmount: o.totalAmount,
    refundWindowSeconds: o.refundWindowSeconds,
    estimatedDuties: o.estimatedDuties,
    actualDuties: o.actualDuties,
    deliveredAt: o.deliveredAt,
    anomalyFlagged: o.anomalyFlagged,
    settled: o.settled,
    token: o.token,
    state: stateName(o.stateIndex),
    stateIndex: o.stateIndex,
    merchant: o.merchant,
    creator: o.creator,
    platform: o.platform,
    customer: o.customer,
    merchantAmount: o.merchantAmount,
    refundReserve: o.refundReserve,
    creatorCommission: o.creatorCommission,
    platformFee: o.platformFee,
    createdBlock: o.createdBlock,
    updatedAt: o.updatedAt.toISOString(),
  }
}

function toAuditDTO(e: EventRow): AuditEntryDTO {
  return {
    event: e.eventName as AuditEventName,
    blockNumber: e.blockNumber,
    txHash: e.txHash,
    logIndex: e.logIndex,
    args: e.args as Record<string, string | boolean>,
    timestamp: e.timestamp ?? null,
  }
}

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'

// Route chain is kept in one fluent expression so `AppType` can be inferred for the RPC client.
const app = new Hono()
  .use('*', cors({ origin: [WEB_ORIGIN], allowMethods: ['GET', 'POST', 'OPTIONS'] }))

  .get('/health', (c) => c.json({ ok: true }))

  .get('/orders', async (c) => {
    const rows = await db.select().from(schema.orders).orderBy(desc(schema.orders.updatedAt))
    return c.json({ orders: rows.map(toOrderDTO) })
  })

  .get('/orders/:orderId', async (c) => {
    const orderId = c.req.param('orderId')
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.orderId, orderId))
    if (!order) return c.json({ error: 'not found' }, 404)
    const audit = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.orderId, orderId))
      .orderBy(asc(schema.events.blockNumber), asc(schema.events.logIndex))
    return c.json({ order: toOrderDTO(order), audit: audit.map(toAuditDTO) })
  })

  .post('/orders/:orderId/metadata', async (c) => {
    const orderId = c.req.param('orderId')
    const body = await c.req.json().catch(() => ({}))
    const parsed = orderMetadataSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

    const { productName, customerCountry, note } = parsed.data
    await db
      .insert(schema.orders)
      .values({
        orderId,
        productName: productName ?? '',
        customerCountry: customerCountry ?? '',
        note: note ?? null,
      })
      .onConflictDoUpdate({
        target: schema.orders.orderId,
        set: {
          ...(productName !== undefined ? { productName } : {}),
          ...(customerCountry !== undefined ? { customerCountry } : {}),
          ...(note !== undefined ? { note } : {}),
          updatedAt: new Date(),
        },
      })
    return c.json({ ok: true })
  })

  .get('/dashboard', async (c) => {
    const rows = await db.select().from(schema.orders)
    let volumeSettled = 0n
    let fundsPending = 0n
    let reservesLocked = 0n
    let disputedAmount = 0n
    let anomalyCount = 0
    for (const o of rows) {
      const state = stateName(o.stateIndex)
      if (o.anomalyFlagged) anomalyCount += 1
      if (state === 'Released' || state === 'Resolved') volumeSettled += BigInt(o.totalAmount)
      else if (state === 'Funded' || state === 'Delivered') {
        fundsPending += BigInt(o.totalAmount)
        reservesLocked += BigInt(o.refundReserve)
      } else if (state === 'Disputed') disputedAmount += BigInt(o.totalAmount)
    }
    const stats: DashboardStatsDTO = {
      volumeSettled: volumeSettled.toString(),
      fundsPending: fundsPending.toString(),
      reservesLocked: reservesLocked.toString(),
      disputedAmount: disputedAmount.toString(),
      anomalyCount,
      orderCount: rows.length,
    }
    return c.json(stats)
  })

  .get('/reconciliation/:orderId', async (c) => {
    const orderId = c.req.param('orderId')
    const [r] = await db
      .select()
      .from(schema.reconciliation)
      .where(eq(schema.reconciliation.orderId, orderId))
    if (!r) return c.json({ error: 'not found' }, 404)
    const est = BigInt(r.estimatedDuties)
    const dto: ReconciliationDTO = {
      orderId: r.orderId,
      estimatedDuties: r.estimatedDuties,
      actualDuties: r.actualDuties,
      dutiesVarianceRatio: est > 0n ? Number(r.actualDuties) / Number(r.estimatedDuties) : null,
      expectedPayout: r.expectedPayout as Record<string, string>,
      actualPayout: r.actualPayout as Record<string, string>,
      mismatch: r.mismatch,
      computedAt: r.computedAt.toISOString(),
    }
    return c.json(dto)
  })

  .get('/indexer/status', async (c) => {
    const [s] = await db.select().from(schema.indexerState).where(eq(schema.indexerState.id, 1))
    const status: IndexerStatusDTO = {
      lastBlock: s?.lastBlock ?? '0',
      chainId: s?.chainId ?? 0,
      escrow: s?.escrow ?? '',
      healthy: !!s,
    }
    return c.json(status)
  })

export const heldStates = HELD_STATES // re-exported for the indexer's reconciliation calc
export type AppType = typeof app
export { app }
