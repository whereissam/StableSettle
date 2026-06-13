#!/usr/bin/env bun
// A minimal x402-protected seller — the "other side" of an agentic nanopayment.
//
// It sells a mocked market-data quote for a few cents of USDC. The point is not the data; it's the
// settlement path: the seller demands payment via HTTP 402, the StableSettle agent pays by calling
// AgentVault.spend (so the price is charged against its on-chain budget cap), and the seller
// verifies that spend on-chain before returning the data. No API key, no off-chain signature, and
// crucially — a payment the agent's vault can't afford simply reverts, so it never gets the data.
//
// Run:  bun --cwd apps/mcp run x402:seller
// Env:  ARC_TESTNET_RPC_URL, ARC_CHAIN_ID?, USDC_ADDRESS, X402_SELLER_ADDRESS, X402_PRICE_USDC?, X402_PORT?

import { createPublicClient, defineChain, getAddress, http, isAddress, type Address } from 'viem'
import { ARC_TESTNET_CHAIN_ID, fromUsdcUnits, toUsdcUnits, USDC_DECIMALS } from '../src/config.ts'
import { decodePaymentHeader, verifyVaultPayment, X402_SCHEME, type PaymentRequirements } from '../src/x402.ts'

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback
  if (v === undefined) {
    console.error(`Missing required env ${key}. See apps/mcp/.env.example (x402 section).`)
    process.exit(1)
  }
  return v
}

const rpcUrl = env('ARC_TESTNET_RPC_URL')
const usdc = getAddress(env('USDC_ADDRESS'))
const sellerRaw = env('X402_SELLER_ADDRESS')
if (!isAddress(sellerRaw)) {
  console.error(`X402_SELLER_ADDRESS is not a valid address: ${sellerRaw}`)
  process.exit(1)
}
const seller: Address = getAddress(sellerRaw)
const priceDollars = Number(process.env.X402_PRICE_USDC ?? '0.01')
const priceUnits = toUsdcUnits(priceDollars)
const port = Number(process.env.X402_PORT ?? '4021')
const network = 'arc-testnet'

const arc = defineChain({
  id: process.env.ARC_CHAIN_ID ? Number(process.env.ARC_CHAIN_ID) : ARC_TESTNET_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: USDC_DECIMALS },
  rpcUrls: { default: { http: [rpcUrl] } },
})
const publicClient = createPublicClient({ chain: arc, transport: http(rpcUrl) })

// Replay protection: a spend tx can settle exactly one request (demo-grade, in-memory).
const consumed = new Set<string>()

function requirementsFor(resource: string): PaymentRequirements {
  return {
    scheme: X402_SCHEME,
    network,
    asset: usdc,
    payTo: seller,
    maxAmountRequired: priceUnits.toString(),
    resource,
    description: 'StableSettle market-data quote (demo). Pay via AgentVault.spend; charged against the budget cap.',
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// A deterministic, obviously-mocked "quote" so the demo has a payload to show. Not real market data.
function quoteFor(pair: string) {
  const seed = [...pair].reduce((a, c) => a + c.charCodeAt(0), 0)
  const price = 1000 + (seed % 4000) + (seed % 97) / 100
  return {
    pair: pair.toUpperCase(),
    price: Number(price.toFixed(2)),
    currency: 'USD',
    source: 'stablesettle-x402-demo',
    disclaimer: 'Mocked quote for the agentic-payment demo — not real market data.',
  }
}

const serverInst = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health') return json({ ok: true, seller, priceUSDC: fromUsdcUnits(priceUnits), usdc })

    // The only product: GET /quote/<pair> (defaults to ETH-USD).
    if (!url.pathname.startsWith('/quote')) return json({ error: 'not found' }, 404)
    const pair = url.pathname.replace(/^\/quote\/?/, '') || 'ETH-USD'
    const resource = `GET /quote/${pair}`
    const requirements = requirementsFor(resource)

    const header = req.headers.get('x-payment')
    if (!header) {
      // x402 challenge: tell the buyer exactly how to pay.
      return json({ x402Version: 1, error: 'payment required', accepts: [requirements] }, 402)
    }

    let txHash: `0x${string}`
    try {
      ;({ txHash } = decodePaymentHeader(header))
    } catch (e) {
      return json({ error: `invalid X-PAYMENT header: ${(e as Error).message}`, accepts: [requirements] }, 402)
    }

    if (consumed.has(txHash.toLowerCase())) {
      return json({ error: 'this payment was already used for another request', accepts: [requirements] }, 402)
    }

    const result = await verifyVaultPayment({ publicClient, txHash, usdc, payTo: seller, minUnits: priceUnits })
    if (!result.ok) {
      return json({ error: `payment not verified: ${result.reason}`, accepts: [requirements] }, 402)
    }

    consumed.add(txHash.toLowerCase())
    console.error(
      `✓ paid: ${fromUsdcUnits(result.paidUnits)} USDC for "${resource}" via vault ${result.from} (tx ${txHash})`,
    )
    return json({
      ...quoteFor(pair),
      paid: { amountUSDC: fromUsdcUnits(result.paidUnits), txHash, viaVault: result.from },
    })
  },
})

console.error(
  `x402 seller live on http://localhost:${serverInst.port}\n` +
    `  product : GET /quote/<pair>  (e.g. /quote/ETH-USD)\n` +
    `  price   : ${fromUsdcUnits(priceUnits)} USDC → ${seller}\n` +
    `  settle  : AgentVault.spend on Arc, verified on-chain before the data is served`,
)
