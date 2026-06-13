import { keccak256, toHex, type Address } from 'viem'
import { toUsdcUnits } from './format'
import { USDC_ADDRESS, EURC_ADDRESS } from './contract'

/**
 * The locked demo order: a $100 cross-border order, US customer, Germany merchant.
 * Buckets: $85 merchant / $8 refund reserve / $5 creator / $2 platform.
 */
export const DEMO_SPLIT = {
  merchantAmount: toUsdcUnits(85),
  refundReserve: toUsdcUnits(8),
  creatorCommission: toUsdcUnits(5),
  platformFee: toUsdcUnits(2),
}

export const DEMO_TOTAL = toUsdcUnits(100)

/** Demo resolution for Scenario B: $70 refunded, $25 to merchant (shipping loss), $5 platform. */
export const DEMO_RESOLUTION = {
  toCustomer: toUsdcUnits(70),
  toMerchant: toUsdcUnits(25),
  toCreator: toUsdcUnits(0),
  toPlatform: toUsdcUnits(5),
}

/** Refund window is short for the demo because on-chain time can't be fast-forwarded. */
export const DEMO_REFUND_WINDOW_SECONDS = 0n

/** Scenario C — duties anomaly: quoted $10, customs charges $35 (>2× → auto-flagged). */
export const DEMO_ESTIMATED_DUTIES = toUsdcUnits(10)
export const DEMO_ACTUAL_DUTIES = toUsdcUnits(35)

export interface DemoOrderTemplate {
  id: `0x${string}`
  label: string
  productName: string
  customerCountry: string
  scenario: 'A' | 'B' | 'C'
  estimatedDuties: bigint
  token: Address // settlement token for this demo order
}

/** Stable order ids derived from a human label so reloads find the same orders. */
function orderId(label: string): `0x${string}` {
  return keccak256(toHex(label))
}

export function makeDemoOrders(suffix: string): DemoOrderTemplate[] {
  return [
    {
      id: orderId(`StableSettle/A/${suffix}`),
      label: 'Normal delivery',
      productName: 'Merino Wool Hoodie',
      customerCountry: 'US → DE',
      scenario: 'A',
      estimatedDuties: 0n,
      token: USDC_ADDRESS,
    },
    {
      id: orderId(`StableSettle/B/${suffix}`),
      label: 'Rejected package',
      productName: 'Espresso Machine',
      customerCountry: 'US → DE',
      scenario: 'B',
      estimatedDuties: 0n,
      token: USDC_ADDRESS,
    },
    {
      id: orderId(`StableSettle/C/${suffix}`),
      label: 'Duties anomaly',
      productName: 'Carbon Road Bike',
      customerCountry: 'US → DE',
      scenario: 'C',
      estimatedDuties: DEMO_ESTIMATED_DUTIES,
      token: USDC_ADDRESS,
    },
    {
      id: orderId(`StableSettle/D/${suffix}`),
      label: 'EURC settlement',
      productName: 'Leather Handbag',
      customerCountry: 'US → FR',
      scenario: 'A',
      estimatedDuties: 0n,
      token: EURC_ADDRESS,
    },
  ]
}

/**
 * Build the Split tuple expected by createOrder. The four recipients all default
 * to the connected account for the demo (one wallet plays every role); pass
 * distinct addresses to make the payout fan-out visible on-chain.
 */
export function buildSplit(opts: {
  merchant: Address
  creator: Address
  platform: Address
  customer: Address
}) {
  return {
    merchant: opts.merchant,
    creator: opts.creator,
    platform: opts.platform,
    customer: opts.customer,
    merchantAmount: DEMO_SPLIT.merchantAmount,
    refundReserve: DEMO_SPLIT.refundReserve,
    creatorCommission: DEMO_SPLIT.creatorCommission,
    platformFee: DEMO_SPLIT.platformFee,
  }
}

export const BUCKETS = [
  { key: 'merchantAmount', label: 'Merchant', color: 'merchant', recipient: 'merchant' },
  { key: 'refundReserve', label: 'Refund reserve', color: 'reserve', recipient: 'customer' },
  { key: 'creatorCommission', label: 'Creator', color: 'creator', recipient: 'creator' },
  { key: 'platformFee', label: 'Platform', color: 'platform', recipient: 'platform' },
] as const
