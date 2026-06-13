import { ExternalLink } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { txUrl } from '@/lib/contract'
import { formatUsd, shortenAddress, shortenHash } from '@/lib/format'
import type { AuditEntry, AuditEventName } from '@/lib/orders'

const EVENT_LABEL: Record<AuditEventName, string> = {
  OrderCreated: 'Order created',
  OrderFunded: 'Funded',
  Delivered: 'Delivered',
  ActualDutiesReported: 'Duties reported',
  AnomalyCleared: 'Anomaly cleared',
  Released: 'Released',
  DisputeRaised: 'Dispute raised',
  DisputeResolved: 'Dispute resolved',
}

const EVENT_VARIANT: Record<AuditEventName, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  OrderCreated: 'secondary',
  OrderFunded: 'default',
  Delivered: 'secondary',
  ActualDutiesReported: 'secondary',
  AnomalyCleared: 'default',
  Released: 'default',
  DisputeRaised: 'destructive',
  DisputeResolved: 'default',
}

function describe(entry: AuditEntry): string {
  const a = entry.args
  switch (entry.event) {
    case 'OrderCreated':
      return `Total ${formatUsd(a.totalAmount as bigint)} · split into 4 buckets`
    case 'OrderFunded':
      return `${formatUsd(a.totalAmount as bigint)} pulled from ${shortenAddress(a.funder as string)}`
    case 'Delivered':
      return 'Oracle marked package delivered'
    case 'ActualDutiesReported':
      return `Actual ${formatUsd(a.actualDuties as bigint)} vs. ${formatUsd(a.estimatedDuties as bigint)} estimated${(a.anomalyFlagged as boolean) ? ' · flagged' : ''}`
    case 'AnomalyCleared':
      return `Cleared by ${shortenAddress(a.clearedBy as string)}`
    case 'Released':
      return `Merchant ${formatUsd(a.merchantAmount as bigint)} · reserve ${formatUsd(a.refundReserve as bigint)} · creator ${formatUsd(a.creatorCommission as bigint)} · platform ${formatUsd(a.platformFee as bigint)}`
    case 'DisputeRaised':
      return `Raised by ${shortenAddress(a.raisedBy as string)}`
    case 'DisputeResolved':
      return `Customer ${formatUsd(a.toCustomer as bigint)} · merchant ${formatUsd(a.toMerchant as bigint)} · creator ${formatUsd(a.toCreator as bigint)} · platform ${formatUsd(a.toPlatform as bigint)}`
    default:
      return ''
  }
}

export function AuditLog({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No events yet — actions will appear here, sourced directly from the contract.
      </p>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[160px]">Event</TableHead>
          <TableHead>Detail</TableHead>
          <TableHead className="w-[120px]">Block</TableHead>
          <TableHead className="w-[160px] text-right">Transaction</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={`${entry.txHash}-${entry.logIndex}`}>
            <TableCell>
              <Badge variant={EVENT_VARIANT[entry.event]}>{EVENT_LABEL[entry.event]}</Badge>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">{describe(entry)}</TableCell>
            <TableCell className="tabular text-sm text-muted-foreground">
              #{entry.blockNumber.toString()}
            </TableCell>
            <TableCell className="text-right">
              <a
                href={txUrl(entry.txHash)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                {shortenHash(entry.txHash)}
                <ExternalLink className="h-3 w-3" />
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
