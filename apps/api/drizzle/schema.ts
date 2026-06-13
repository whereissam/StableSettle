import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/** Big on-chain integers are stored as numeric(78,0) — fits a uint256, returned as a string. */
const amount = (name: string) => numeric(name, { precision: 78, scale: 0 })

/** Merchant profile (created on first Dynamic login, or on first OrderCreated). */
export const merchants = pgTable('merchants', {
  address: text('address').primaryKey(),
  name: text('name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/** Order metadata mirrored from the chain + off-chain display fields. */
export const orders = pgTable('orders', {
  orderId: text('order_id').primaryKey(),
  productName: text('product_name').default('').notNull(),
  customerCountry: text('customer_country').default('').notNull(),
  note: text('note'),
  totalAmount: amount('total_amount').default('0').notNull(),
  refundWindowSeconds: amount('refund_window_seconds').default('0').notNull(),
  estimatedDuties: amount('estimated_duties').default('0').notNull(),
  actualDuties: amount('actual_duties').default('0').notNull(),
  deliveredAt: amount('delivered_at').default('0').notNull(),
  anomalyFlagged: boolean('anomaly_flagged').default(false).notNull(),
  settled: boolean('settled').default(false).notNull(),
  token: text('token').default('').notNull(),
  stateIndex: integer('state_index').default(0).notNull(),
  merchant: text('merchant').default('').notNull(),
  creator: text('creator').default('').notNull(),
  platform: text('platform').default('').notNull(),
  customer: text('customer').default('').notNull(),
  merchantAmount: amount('merchant_amount').default('0').notNull(),
  refundReserve: amount('refund_reserve').default('0').notNull(),
  creatorCommission: amount('creator_commission').default('0').notNull(),
  platformFee: amount('platform_fee').default('0').notNull(),
  createdBlock: amount('created_block').default('0').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

/** Mirrored contract event log — the source of the audit trail. */
export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    orderId: text('order_id').notNull(),
    eventName: text('event_name').notNull(),
    blockNumber: amount('block_number').notNull(),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    args: jsonb('args').notNull(),
    timestamp: amount('timestamp'),
  },
  (t) => ({
    uniqLog: uniqueIndex('events_tx_log_uniq').on(t.txHash, t.logIndex),
  }),
)

/** Per-order reconciliation: estimated vs actual duties, expected vs actual payouts. */
export const reconciliation = pgTable('reconciliation', {
  orderId: text('order_id').primaryKey(),
  estimatedDuties: amount('estimated_duties').default('0').notNull(),
  actualDuties: amount('actual_duties').default('0').notNull(),
  expectedPayout: jsonb('expected_payout').notNull(),
  actualPayout: jsonb('actual_payout').notNull(),
  mismatch: boolean('mismatch').default(false).notNull(),
  computedAt: timestamp('computed_at').defaultNow().notNull(),
})

/** Single-row indexer cursor so the worker resumes after a restart. */
export const indexerState = pgTable('indexer_state', {
  id: integer('id').primaryKey().default(1),
  lastBlock: amount('last_block').default('0').notNull(),
  chainId: integer('chain_id').default(0).notNull(),
  escrow: text('escrow').default('').notNull(),
})
