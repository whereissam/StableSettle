import type { Address, PublicClient } from 'viem'
import { escrowAbi, ESCROW_ADDRESS, stateName, type OrderState } from './contract'

/** Block to start scanning events from. Set VITE_DEPLOY_BLOCK to the deploy block to speed this up. */
const FROM_BLOCK: bigint = (() => {
  const v = import.meta.env.VITE_DEPLOY_BLOCK
  try {
    return v ? BigInt(v) : 0n
  } catch {
    return 0n
  }
})()

export interface Bucket {
  merchant: bigint
  refundReserve: bigint
  creator: bigint
  platform: bigint
}

export interface OrderSummary {
  orderId: `0x${string}`
  productName: string
  customerCountry: string
  totalAmount: bigint
  refundWindowSeconds: bigint
  deliveredAt: bigint
  estimatedDuties: bigint
  actualDuties: bigint
  anomalyFlagged: boolean
  token: Address
  state: OrderState
  stateIndex: number
  settled: boolean
  parties: {
    merchant: Address
    creator: Address
    platform: Address
    customer: Address
  }
  buckets: Bucket
}

export type AuditEventName =
  | 'OrderCreated'
  | 'OrderFunded'
  | 'Delivered'
  | 'ActualDutiesReported'
  | 'AnomalyCleared'
  | 'Released'
  | 'DisputeRaised'
  | 'DisputeResolved'

export interface AuditEntry {
  event: AuditEventName
  blockNumber: bigint
  txHash: `0x${string}`
  logIndex: number
  args: Record<string, unknown>
}

const AUDIT_EVENTS: AuditEventName[] = [
  'OrderCreated',
  'OrderFunded',
  'Delivered',
  'ActualDutiesReported',
  'AnomalyCleared',
  'Released',
  'DisputeRaised',
  'DisputeResolved',
]

/**
 * Max block span per eth_getLogs request. Public Arc RPCs cap eth_getLogs at 10k
 * blocks — a wider range is rejected with 413 (Content Too Large) / 400 (range too
 * wide), regardless of how many logs match. So we page through the chain in bounded
 * windows. Set VITE_DEPLOY_BLOCK to the escrow's deploy block to cut request count.
 */
const MAX_BLOCK_RANGE = 9_000n
/** How many windows to scan in parallel. Keeps wall-time down without flooding RPCs. */
const PAGE_CONCURRENCY = 8

/** Decoded log shape the callers consume (getContractEvents returns these at runtime). */
type EventLog = {
  eventName: string
  args: Record<string, unknown>
  blockNumber: bigint | null
  transactionHash: `0x${string}` | null
  logIndex: number | null
}
type ContractEventsParams = Omit<
  Parameters<PublicClient['getContractEvents']>[0],
  'fromBlock' | 'toBlock'
>

/** Fetch one window, recursively halving if the RPC still rejects the range/size. */
async function getEventsWindow(
  client: PublicClient,
  params: ContractEventsParams,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<EventLog[]> {
  try {
    const logs = await client.getContractEvents({
      ...params,
      fromBlock,
      toBlock,
    } as Parameters<PublicClient['getContractEvents']>[0])
    return logs as unknown as EventLog[]
  } catch (err) {
    if (toBlock > fromBlock) {
      const mid = fromBlock + (toBlock - fromBlock) / 2n
      const [a, b] = await Promise.all([
        getEventsWindow(client, params, fromBlock, mid),
        getEventsWindow(client, params, mid + 1n, toBlock),
      ])
      return [...a, ...b]
    }
    throw err
  }
}

/**
 * Page client.getContractEvents across [fromBlock, toBlock] in <= MAX_BLOCK_RANGE
 * windows, scanning PAGE_CONCURRENCY windows at a time.
 */
async function getContractEventsPaged(
  client: PublicClient,
  params: ContractEventsParams,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<EventLog[]> {
  if (toBlock < fromBlock) return []

  const windows: Array<[bigint, bigint]> = []
  for (let start = fromBlock; start <= toBlock; start += MAX_BLOCK_RANGE) {
    const end = start + MAX_BLOCK_RANGE - 1n
    windows.push([start, end > toBlock ? toBlock : end])
  }

  const results: EventLog[][] = new Array(windows.length)
  let next = 0
  async function worker() {
    for (;;) {
      const i = next++
      if (i >= windows.length) return
      results[i] = await getEventsWindow(client, params, windows[i][0], windows[i][1])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PAGE_CONCURRENCY, windows.length) }, worker),
  )
  return results.flat()
}

/**
 * Incremental cache for OrderCreated logs. Past block ranges are immutable history,
 * so on refetch (the dashboard polls every few seconds) we only scan the blocks
 * mined since the last scan instead of re-walking deploy→latest every time.
 */
let createdCache: { fromBlock: bigint; lastScanned: bigint; logs: EventLog[] } | null = null

/** Discover every order id from OrderCreated events (incrementally cached). */
export async function getAllOrderCreated(client: PublicClient): Promise<EventLog[]> {
  const latest = await client.getBlockNumber()
  const params: ContractEventsParams = {
    address: ESCROW_ADDRESS,
    abi: escrowAbi,
    eventName: 'OrderCreated',
  }

  // Cold cache (or deploy block changed) → full scan.
  if (!createdCache || createdCache.fromBlock !== FROM_BLOCK) {
    const logs = await getContractEventsPaged(client, params, FROM_BLOCK, latest)
    createdCache = { fromBlock: FROM_BLOCK, lastScanned: latest, logs }
    return logs
  }

  // Warm cache → only scan the newly mined tail.
  if (latest > createdCache.lastScanned) {
    const fresh = await getContractEventsPaged(
      client,
      params,
      createdCache.lastScanned + 1n,
      latest,
    )
    createdCache = {
      ...createdCache,
      lastScanned: latest,
      logs: [...createdCache.logs, ...fresh],
    }
  }
  return createdCache.logs
}

/** Read the live struct for an order from the contract. */
export async function readOrder(
  client: PublicClient,
  orderId: `0x${string}`,
  created: { productName: string; customerCountry: string },
): Promise<OrderSummary> {
  const o = (await client.readContract({
    address: ESCROW_ADDRESS,
    abi: escrowAbi,
    functionName: 'getOrder',
    args: [orderId],
  })) as {
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

  return {
    orderId,
    productName: created.productName,
    customerCountry: created.customerCountry,
    totalAmount: o.totalAmount,
    refundWindowSeconds: o.refundWindowSeconds,
    deliveredAt: o.deliveredAt,
    estimatedDuties: o.estimatedDuties,
    actualDuties: o.actualDuties,
    anomalyFlagged: o.anomalyFlagged,
    token: o.token,
    state: stateName(o.state),
    stateIndex: o.state,
    settled: o.settled,
    parties: {
      merchant: o.split.merchant,
      creator: o.split.creator,
      platform: o.split.platform,
      customer: o.split.customer,
    },
    buckets: {
      merchant: o.split.merchantAmount,
      refundReserve: o.split.refundReserve,
      creator: o.split.creatorCommission,
      platform: o.split.platformFee,
    },
  }
}

/** Read every order (created events + current on-chain state), newest first. */
export async function getAllOrders(client: PublicClient): Promise<OrderSummary[]> {
  const createdLogs = await getAllOrderCreated(client)
  const orders = await Promise.all(
    createdLogs.map((log) => {
      const args = log.args as {
        orderId: `0x${string}`
        productName: string
        customerCountry: string
      }
      return readOrder(client, args.orderId, {
        productName: args.productName,
        customerCountry: args.customerCountry,
      })
    }),
  )
  // De-dupe by orderId (a re-created id keeps the latest) and reverse for newest-first.
  const byId = new Map<string, OrderSummary>()
  orders.forEach((o) => byId.set(o.orderId, o))
  return [...byId.values()].reverse()
}

/**
 * Reconstruct the full audit log for one order from contract events.
 * Pass `fromBlock` (the order's OrderCreated block) to scan only that order's
 * lifetime instead of the whole chain since deploy — a much smaller range.
 */
export async function getAuditLog(
  client: PublicClient,
  orderId: `0x${string}`,
  fromBlock: bigint = FROM_BLOCK,
): Promise<AuditEntry[]> {
  const latest = await client.getBlockNumber()
  const all = await Promise.all(
    AUDIT_EVENTS.map((eventName) =>
      getContractEventsPaged(
        client,
        { address: ESCROW_ADDRESS, abi: escrowAbi, eventName, args: { orderId } },
        fromBlock,
        latest,
      ),
    ),
  )

  const entries: AuditEntry[] = all.flat().map((log) => ({
    event: log.eventName as AuditEventName,
    blockNumber: log.blockNumber ?? 0n,
    txHash: log.transactionHash ?? '0x',
    logIndex: log.logIndex ?? 0,
    args: (log.args ?? {}) as Record<string, unknown>,
  }))

  // Chronological order.
  entries.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  )
  return entries
}

/** Aggregate dashboard stats across all orders. */
export interface DashboardStats {
  volumeSettled: bigint // released + resolved totals
  fundsPending: bigint // funded/delivered totals still in escrow
  reservesLocked: bigint // refund reserves on funded/delivered orders
  disputedAmount: bigint
  anomalyCount: number // orders flagged for duties review
  orderCount: number
}

export function computeStats(orders: OrderSummary[]): DashboardStats {
  let volumeSettled = 0n
  let fundsPending = 0n
  let reservesLocked = 0n
  let disputedAmount = 0n
  let anomalyCount = 0

  for (const o of orders) {
    if (o.anomalyFlagged) anomalyCount += 1
    switch (o.state) {
      case 'Released':
      case 'Resolved':
        volumeSettled += o.totalAmount
        break
      case 'Funded':
      case 'Delivered':
        fundsPending += o.totalAmount
        reservesLocked += o.buckets.refundReserve
        break
      case 'Disputed':
        disputedAmount += o.totalAmount
        break
    }
  }

  return {
    volumeSettled,
    fundsPending,
    reservesLocked,
    disputedAmount,
    anomalyCount,
    orderCount: orders.length,
  }
}
