import { formatUnits, parseUnits } from 'viem'

/** USDC uses 6 decimals on Arc. */
export const USDC_DECIMALS = 6

/** Parse a human USDC string ("85" or "85.5") into base units. */
export function toUsdcUnits(amount: string | number): bigint {
  return parseUnits(String(amount), USDC_DECIMALS)
}

/** Format base-unit USDC as a plain number string, e.g. 85000000n -> "85.00". */
export function fromUsdcUnits(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS)
}

/** Format base-unit USDC as currency, e.g. 85000000n -> "$85.00". */
export function formatUsd(amount: bigint): string {
  const n = Number(formatUnits(amount, USDC_DECIMALS))
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

/**
 * Currency-aware amount: same 6-decimal formatting, prefixed by the token's symbol
 * ($ for USDC, € for EURC). Use where a specific order's token is known.
 */
export function formatMoney(amount: bigint, prefix: '$' | '€' = '$'): string {
  const n = Number(formatUnits(amount, USDC_DECIMALS))
  return `${prefix}${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)}`
}

/** Shorten an address for display: 0x1234… abcd. */
export function shortenAddress(address?: string): string {
  if (!address) return ''
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** Shorten a tx hash similarly. */
export function shortenHash(hash?: string): string {
  if (!hash) return ''
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}

export function formatTimestamp(seconds: number | bigint): string {
  const ms = Number(seconds) * 1000
  if (!ms) return '—'
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
