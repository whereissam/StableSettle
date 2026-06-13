import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import {
  getAllOrders,
  getAuditLog,
  readOrder,
  computeStats,
  getAllOrderCreated,
} from '@/lib/orders'
import { isConfigured } from '@/lib/contract'
import { api, apiEnabled, dtoToOrderSummary, dtoToAuditEntry } from '@/lib/api'

/** All orders + derived dashboard stats. Reads from the API when configured, else from chain. */
export function useOrders() {
  const client = usePublicClient()
  return useQuery({
    queryKey: ['orders', apiEnabled],
    enabled: apiEnabled || (!!client && isConfigured),
    refetchInterval: 4000,
    queryFn: async () => {
      if (apiEnabled && api) {
        const res = await api.orders.$get()
        const { orders: dtos } = await res.json()
        const orders = dtos.map(dtoToOrderSummary)
        return { orders, stats: computeStats(orders) }
      }
      const orders = await getAllOrders(client!)
      return { orders, stats: computeStats(orders) }
    },
  })
}

/** A single order plus its full event-sourced audit log. */
export function useOrder(orderId?: `0x${string}`) {
  const client = usePublicClient()
  return useQuery({
    queryKey: ['order', orderId, apiEnabled],
    enabled: !!orderId && (apiEnabled || (!!client && isConfigured)),
    refetchInterval: 3000,
    queryFn: async () => {
      if (apiEnabled && api) {
        const res = await api.orders[':orderId'].$get({ param: { orderId: orderId! } })
        if (!res.ok) throw new Error('order not found')
        const data = await res.json()
        if ('error' in data) throw new Error('order not found')
        return {
          order: dtoToOrderSummary(data.order),
          audit: data.audit.map(dtoToAuditEntry),
        }
      }

      // Chain path: find OrderCreated metadata, then read struct + replay events.
      const created = await getAllOrderCreated(client!)
      const match = created.find((l) => (l.args as { orderId: string }).orderId === orderId)
      const meta = match
        ? {
            productName: (match.args as { productName: string }).productName,
            customerCountry: (match.args as { customerCountry: string }).customerCountry,
          }
        : { productName: 'Order', customerCountry: '' }

      const [order, audit] = await Promise.all([
        readOrder(client!, orderId!, meta),
        // Scan the audit log only from this order's creation block when known.
        getAuditLog(client!, orderId!, match?.blockNumber ?? undefined),
      ])
      return { order, audit }
    },
  })
}
