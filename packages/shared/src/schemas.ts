import { z } from 'zod'

/** A 0x-prefixed EVM address. */
export const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x address')

/** A bytes32 order id. */
export const orderIdSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'must be a bytes32 hex string')

/** A non-negative integer amount in token base units, carried as a string (bigint-safe). */
export const amountSchema = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer string')

/**
 * The four-bucket split. The "sums to total" invariant lives here so the same check
 * runs on the API, the indexer, and (imported) the frontend — mirroring the contract.
 */
export const splitSchema = z.object({
  merchant: addressSchema,
  creator: addressSchema,
  platform: addressSchema,
  customer: addressSchema,
  merchantAmount: amountSchema,
  refundReserve: amountSchema,
  creatorCommission: amountSchema,
  platformFee: amountSchema,
})

export type Split = z.infer<typeof splitSchema>

/** Sum of the four bucket amounts, as a bigint. */
export function bucketSum(split: Split): bigint {
  return (
    BigInt(split.merchantAmount) +
    BigInt(split.refundReserve) +
    BigInt(split.creatorCommission) +
    BigInt(split.platformFee)
  )
}

/** True iff the four buckets sum exactly to the total — the contract's createOrder invariant. */
export function splitConserves(split: Split, total: string): boolean {
  return bucketSum(split) === BigInt(total)
}

/** A four-way dispute payout. */
export const payoutSchema = z.object({
  toCustomer: amountSchema,
  toMerchant: amountSchema,
  toCreator: amountSchema,
  toPlatform: amountSchema,
})

export type Payout = z.infer<typeof payoutSchema>

export function payoutSum(p: Payout): bigint {
  return BigInt(p.toCustomer) + BigInt(p.toMerchant) + BigInt(p.toCreator) + BigInt(p.toPlatform)
}

/** True iff the four payouts sum exactly to the total — the contract's resolveDispute invariant. */
export function payoutConserves(p: Payout, total: string): boolean {
  return payoutSum(p) === BigInt(total)
}

/** Off-chain order metadata a merchant can attach/edit (display only; never affects funds). */
export const orderMetadataSchema = z.object({
  productName: z.string().min(1).max(120).optional(),
  customerCountry: z.string().min(1).max(80).optional(),
  note: z.string().max(500).optional(),
})

export type OrderMetadataInput = z.infer<typeof orderMetadataSchema>
