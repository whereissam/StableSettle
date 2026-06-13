import { createPublicClient, http, type Abi, type Address } from 'viem'
import { arcTestnet } from 'viem/chains'
import { db, schema, initDb, eq } from '@stablesettle/api/db'
import { escrowAbi } from '@stablesettle/shared/abi'
import {
  RPC_URL,
  ESCROW_ADDRESS,
  CHAIN_ID,
  DEPLOY_BLOCK,
  POLL_INTERVAL_MS,
  isConfigured,
} from './config'

const abi = escrowAbi as Abi
const MAX_RANGE = 9_999n // cap getLogs span to keep RPCs happy

const client = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) })

const blockTimestamps = new Map<string, string>()
async function blockTimestamp(blockNumber: bigint): Promise<string> {
  const key = blockNumber.toString()
  const cached = blockTimestamps.get(key)
  if (cached) return cached
  const block = await client.getBlock({ blockNumber })
  const ts = block.timestamp.toString()
  blockTimestamps.set(key, ts)
  return ts
}

type OrderStruct = {
  totalAmount: bigint
  deliveredAt: bigint
  refundWindowSeconds: bigint
  estimatedDuties: bigint
  actualDuties: bigint
  token: Address
  state: number
  settled: boolean
  anomalyFlagged: boolean
  split: {
    merchant: Address
    creator: Address
    platform: Address
    customer: Address
    merchantAmount: bigint
    refundReserve: bigint
    creatorCommission: bigint
    platformFee: bigint
  }
}

async function readOrder(orderId: `0x${string}`): Promise<OrderStruct> {
  return (await client.readContract({
    address: ESCROW_ADDRESS,
    abi,
    functionName: 'getOrder',
    args: [orderId],
  })) as OrderStruct
}

/** Decoded event args → a JSON-safe record (bigints → strings). */
function serializeArgs(args: Record<string, unknown>): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'bigint') out[k] = v.toString()
    else if (typeof v === 'boolean') out[k] = v
    else out[k] = String(v)
  }
  return out
}

/** Write the on-chain part of an order from its live struct. */
async function writeChainState(
  orderId: string,
  o: OrderStruct,
  created?: { productName: string; customerCountry: string; createdBlock: bigint },
) {
  const chainFields = {
    totalAmount: o.totalAmount.toString(),
    refundWindowSeconds: o.refundWindowSeconds.toString(),
    estimatedDuties: o.estimatedDuties.toString(),
    actualDuties: o.actualDuties.toString(),
    deliveredAt: o.deliveredAt.toString(),
    token: o.token,
    anomalyFlagged: o.anomalyFlagged,
    settled: o.settled,
    stateIndex: o.state,
    merchant: o.split.merchant,
    creator: o.split.creator,
    platform: o.split.platform,
    customer: o.split.customer,
    merchantAmount: o.split.merchantAmount.toString(),
    refundReserve: o.split.refundReserve.toString(),
    creatorCommission: o.split.creatorCommission.toString(),
    platformFee: o.split.platformFee.toString(),
    updatedAt: new Date(),
  }

  if (created) {
    await db
      .insert(schema.orders)
      .values({
        orderId,
        productName: created.productName,
        customerCountry: created.customerCountry,
        createdBlock: created.createdBlock.toString(),
        ...chainFields,
      })
      .onConflictDoUpdate({
        target: schema.orders.orderId,
        // On re-create, refresh chain fields + display fields but keep any operator note.
        set: {
          productName: created.productName,
          customerCountry: created.customerCountry,
          createdBlock: created.createdBlock.toString(),
          ...chainFields,
        },
      })
  } else {
    // Non-create event: only update chain-derived fields; never an insert (order must exist).
    await db.update(schema.orders).set(chainFields).where(eq(schema.orders.orderId, orderId))
  }

  await recomputeReconciliation(orderId, o)
}

/** Expected vs actual payout per recipient + duties variance. */
async function recomputeReconciliation(orderId: string, o: OrderStruct) {
  const expectedPayout = {
    customer: o.split.refundReserve.toString(), // reserve returns to customer on normal release
    merchant: o.split.merchantAmount.toString(),
    creator: o.split.creatorCommission.toString(),
    platform: o.split.platformFee.toString(),
  }

  let actualPayout: Record<string, string> = {}
  const settlementEvents = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.orderId, orderId))
  for (const e of settlementEvents) {
    const a = e.args as Record<string, string>
    if (e.eventName === 'Released') {
      actualPayout = {
        customer: a.refundReserve,
        merchant: a.merchantAmount,
        creator: a.creatorCommission,
        platform: a.platformFee,
      }
    } else if (e.eventName === 'DisputeResolved') {
      actualPayout = {
        customer: a.toCustomer,
        merchant: a.toMerchant,
        creator: a.toCreator,
        platform: a.toPlatform,
      }
    }
  }

  const settled = Object.keys(actualPayout).length > 0
  const mismatch =
    settled && JSON.stringify(actualPayout) !== JSON.stringify(expectedPayout)

  await db
    .insert(schema.reconciliation)
    .values({
      orderId,
      estimatedDuties: o.estimatedDuties.toString(),
      actualDuties: o.actualDuties.toString(),
      expectedPayout,
      actualPayout,
      mismatch,
      computedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.reconciliation.orderId,
      set: {
        estimatedDuties: o.estimatedDuties.toString(),
        actualDuties: o.actualDuties.toString(),
        expectedPayout,
        actualPayout,
        mismatch,
        computedAt: new Date(),
      },
    })
}

async function processLog(log: {
  eventName: string
  args: Record<string, unknown>
  blockNumber: bigint | null
  transactionHash: `0x${string}` | null
  logIndex: number | null
}) {
  const args = log.args ?? {}
  const orderId = args.orderId as string | undefined
  if (!orderId) return

  const ts = log.blockNumber !== null ? await blockTimestamp(log.blockNumber) : null

  await db
    .insert(schema.events)
    .values({
      orderId,
      eventName: log.eventName,
      blockNumber: (log.blockNumber ?? 0n).toString(),
      txHash: log.transactionHash ?? '0x',
      logIndex: log.logIndex ?? 0,
      args: serializeArgs(args),
      timestamp: ts,
    })
    .onConflictDoNothing()

  const o = await readOrder(orderId as `0x${string}`)
  if (log.eventName === 'OrderCreated') {
    await writeChainState(orderId, o, {
      productName: (args.productName as string) ?? '',
      customerCountry: (args.customerCountry as string) ?? '',
      createdBlock: log.blockNumber ?? 0n,
    })
  } else {
    await writeChainState(orderId, o)
  }
}

async function getCursor(): Promise<bigint> {
  const [row] = await db.select().from(schema.indexerState).where(eq(schema.indexerState.id, 1))
  if (!row) {
    const start = DEPLOY_BLOCK > 0n ? DEPLOY_BLOCK - 1n : 0n
    await db.insert(schema.indexerState).values({
      id: 1,
      lastBlock: start.toString(),
      chainId: CHAIN_ID,
      escrow: ESCROW_ADDRESS,
    })
    return start
  }
  return BigInt(row.lastBlock)
}

async function setCursor(block: bigint) {
  await db
    .update(schema.indexerState)
    .set({ lastBlock: block.toString(), chainId: CHAIN_ID, escrow: ESCROW_ADDRESS })
    .where(eq(schema.indexerState.id, 1))
}

async function main() {
  await initDb()

  if (!isConfigured) {
    console.error('[indexer] No escrow address configured (deployments.json / ESCROW_ADDRESS). Idling.')
    // Idle so the process stays up (e.g. under docker) until configured.
    setInterval(() => {}, 1 << 30)
    return
  }

  console.log(`[indexer] Watching ${ESCROW_ADDRESS} on chain ${CHAIN_ID} via ${RPC_URL}`)
  let lastBlock = await getCursor()

  // Sanity: keep the cursor from running ahead of a fresh chain.
  const tip = await client.getBlockNumber()
  if (lastBlock > tip) {
    lastBlock = DEPLOY_BLOCK > 0n ? DEPLOY_BLOCK - 1n : 0n
    await setCursor(lastBlock)
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const latest = await client.getBlockNumber()
      if (latest > lastBlock) {
        const from = lastBlock + 1n
        const to = from + MAX_RANGE > latest ? latest : from + MAX_RANGE
        const logs = await client.getContractEvents({ address: ESCROW_ADDRESS, abi, fromBlock: from, toBlock: to })
        logs.sort((a, b) => {
          const ba = a.blockNumber ?? 0n
          const bb = b.blockNumber ?? 0n
          if (ba !== bb) return ba < bb ? -1 : 1
          return (a.logIndex ?? 0) - (b.logIndex ?? 0)
        })
        for (const log of logs) {
          await processLog(log as Parameters<typeof processLog>[0])
        }
        if (logs.length > 0) console.log(`[indexer] blocks ${from}–${to}: ${logs.length} event(s)`)
        lastBlock = to
        await setCursor(lastBlock)
      }
    } catch (err) {
      console.error('[indexer] poll error:', err instanceof Error ? err.message : err)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

main().catch((err) => {
  console.error('[indexer] fatal:', err)
  process.exit(1)
})
