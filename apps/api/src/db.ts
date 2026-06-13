import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '../drizzle/schema'

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://stablesettle:stablesettle@localhost:5433/stablesettle'

// One pooled connection, shared by the API and the indexer (both import this module).
// `onnotice` silences the harmless "relation already exists" notices from idempotent DDL.
const queryClient = postgres(DATABASE_URL, { max: 10, onnotice: () => {} })

export const db = drizzle(queryClient, { schema })
export { schema }
export type Database = typeof db

// Re-export the query operators consumers need, so they bind to *this* drizzle-orm instance
// (avoids dual-instance type clashes across workspace packages).
export { eq, asc, desc, sql } from 'drizzle-orm'

/**
 * Create tables if they don't exist. Cheap to run on every boot — keeps the demo
 * single-command (no separate migration step). For production, switch to drizzle-kit migrations.
 */
export async function initDb(): Promise<void> {
  // Serialize DDL across processes (API + indexer boot together) — concurrent CREATE TABLE
  // races at the catalog level. An advisory lock makes initDb safe to call from anywhere.
  await queryClient.unsafe('SELECT pg_advisory_lock(727274)')
  try {
    await initSchema()
  } finally {
    await queryClient.unsafe('SELECT pg_advisory_unlock(727274)')
  }
}

async function initSchema(): Promise<void> {
  await queryClient.unsafe(`
    CREATE TABLE IF NOT EXISTS merchants (
      address     text PRIMARY KEY,
      name        text,
      created_at  timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS orders (
      order_id             text PRIMARY KEY,
      product_name         text NOT NULL DEFAULT '',
      customer_country     text NOT NULL DEFAULT '',
      note                 text,
      total_amount         numeric(78,0) NOT NULL DEFAULT 0,
      refund_window_seconds numeric(78,0) NOT NULL DEFAULT 0,
      estimated_duties     numeric(78,0) NOT NULL DEFAULT 0,
      actual_duties        numeric(78,0) NOT NULL DEFAULT 0,
      delivered_at         numeric(78,0) NOT NULL DEFAULT 0,
      anomaly_flagged      boolean NOT NULL DEFAULT false,
      settled              boolean NOT NULL DEFAULT false,
      token                text NOT NULL DEFAULT '',
      state_index          integer NOT NULL DEFAULT 0,
      merchant             text NOT NULL DEFAULT '',
      creator              text NOT NULL DEFAULT '',
      platform             text NOT NULL DEFAULT '',
      customer             text NOT NULL DEFAULT '',
      merchant_amount      numeric(78,0) NOT NULL DEFAULT 0,
      refund_reserve       numeric(78,0) NOT NULL DEFAULT 0,
      creator_commission   numeric(78,0) NOT NULL DEFAULT 0,
      platform_fee         numeric(78,0) NOT NULL DEFAULT 0,
      created_block        numeric(78,0) NOT NULL DEFAULT 0,
      updated_at           timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS events (
      id           serial PRIMARY KEY,
      order_id     text NOT NULL,
      event_name   text NOT NULL,
      block_number numeric(78,0) NOT NULL,
      tx_hash      text NOT NULL,
      log_index    integer NOT NULL,
      args         jsonb NOT NULL,
      timestamp    numeric(78,0)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS events_tx_log_uniq ON events (tx_hash, log_index);
    CREATE INDEX IF NOT EXISTS events_order_idx ON events (order_id);

    CREATE TABLE IF NOT EXISTS reconciliation (
      order_id         text PRIMARY KEY,
      estimated_duties numeric(78,0) NOT NULL DEFAULT 0,
      actual_duties    numeric(78,0) NOT NULL DEFAULT 0,
      expected_payout  jsonb NOT NULL,
      actual_payout    jsonb NOT NULL,
      mismatch         boolean NOT NULL DEFAULT false,
      computed_at      timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS indexer_state (
      id         integer PRIMARY KEY DEFAULT 1,
      last_block numeric(78,0) NOT NULL DEFAULT 0,
      chain_id   integer NOT NULL DEFAULT 0,
      escrow     text NOT NULL DEFAULT ''
    );
  `)
}
