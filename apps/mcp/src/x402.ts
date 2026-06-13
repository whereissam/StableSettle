// x402 nanopayments, settled *through* AgentVault.
//
// Standard x402 (HTTP 402 Payment Required) settles a payment with an off-chain EIP-3009
// authorization signed by the payer's own wallet — the wallet holds the USDC and authorizes a
// `transferWithAuthorization` to the seller. StableSettle is deliberately different: the agent's
// USDC does not live in its wallet, it lives in AgentVault, and the agent only holds AGENT_ROLE.
// So the payment is an on-chain `AgentVault.spend(seller, amount)` call — which means the budget
// cap is enforced on the *nanopayment itself*. A spend over budget reverts, so a hijacked or
// over-eager agent simply cannot pay, even for a $0.01 API call.
//
// Proof of payment is the spend transaction. The seller verifies it on-chain: only the canonical
// USDC contract can emit a `Transfer(vault → seller)`, so the receipt is unspoofable evidence the
// seller was actually paid. The agent never reveals a key or signs an off-chain authorization.

import { decodeEventLog, getAddress, type Address, type Hash, type PublicClient } from 'viem'

/** Our x402 scheme: the payment is an on-chain AgentVault.spend, proven by the spend tx receipt. */
export const X402_SCHEME = 'arc-vault-spend'

/** Minimal ERC-20 Transfer event ABI — the shared erc20.json omits events; we only need this one. */
const transferEventAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

/** The payment requirements a seller advertises in its HTTP 402 body. */
export interface PaymentRequirements {
  scheme: string
  network: string
  /** USDC token address the seller wants to be paid in. */
  asset: Address
  /** Where the payment must land (the seller's address). */
  payTo: Address
  /** Price in USDC base units (6 decimals) as a decimal string, e.g. "10000" = $0.01. */
  maxAmountRequired: string
  /** What is being purchased, e.g. "GET /quote/ETH-USD". */
  resource: string
  description?: string
}

/** The X-PAYMENT header payload the client sends on retry — the on-chain settlement proof. */
interface PaymentPayload {
  scheme: string
  network: string
  /** The AgentVault.spend transaction hash. */
  txHash: Hash
}

function encodePaymentHeader(p: PaymentPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64')
}

export function decodePaymentHeader(header: string): PaymentPayload {
  const json = Buffer.from(header, 'base64').toString('utf8')
  const p = JSON.parse(json) as PaymentPayload
  if (!p || typeof p.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(p.txHash)) {
    throw new Error('X-PAYMENT header missing a valid txHash')
  }
  return p
}

function pickRequirements(body: unknown): PaymentRequirements {
  const accepts = (body as { accepts?: unknown })?.accepts
  const req = Array.isArray(accepts) ? accepts[0] : (body as PaymentRequirements)
  if (!req || typeof req !== 'object') throw new Error('402 response had no payment requirements')
  const r = req as Partial<PaymentRequirements>
  if (!r.payTo || !r.asset || !r.maxAmountRequired || !r.resource) {
    throw new Error('402 payment requirements are incomplete (need asset, payTo, maxAmountRequired, resource)')
  }
  return r as PaymentRequirements
}

export interface X402Result {
  data: unknown
  requirements: PaymentRequirements
  txHash: Hash
  paidUnits: bigint
}

/**
 * Fetch an x402-protected resource, paying for it via `pay` when challenged.
 *
 * GET the URL → on 402, hand the seller's requirements to `pay` (which performs the on-chain
 * AgentVault.spend and returns the tx hash) → retry the GET with the spend tx as proof. `pay`
 * is where the caller enforces *its own* guardrails (right asset, price ceiling) before spending.
 */
export async function fetchWithX402(
  url: string,
  pay: (req: PaymentRequirements) => Promise<{ txHash: Hash; paidUnits: bigint }>,
): Promise<X402Result> {
  const challenge = await fetch(url)
  if (challenge.status !== 402) {
    throw new Error(
      `Expected HTTP 402 Payment Required from ${url}, got ${challenge.status}. ` +
        'This endpoint does not look x402-protected.',
    )
  }

  const requirements = pickRequirements(await challenge.json().catch(() => ({})))
  const { txHash, paidUnits } = await pay(requirements)

  const settled = await fetch(url, {
    headers: { 'X-PAYMENT': encodePaymentHeader({ scheme: requirements.scheme, network: requirements.network, txHash }) },
  })
  if (!settled.ok) {
    const detail = await settled.text().catch(() => '')
    throw new Error(`Paid ${txHash} but the seller rejected it (HTTP ${settled.status}): ${detail.slice(0, 300)}`)
  }

  const data = await settled.json().catch(() => settled.text())
  return { data, requirements, txHash, paidUnits }
}

export interface VerifyParams {
  publicClient: PublicClient
  txHash: Hash
  /** Canonical USDC token address — only Transfer logs from this contract count. */
  usdc: Address
  /** The seller address that must have received the funds. */
  payTo: Address
  /** Minimum USDC base units the seller must have received. */
  minUnits: bigint
}

export interface VerifyResult {
  ok: boolean
  reason?: string
  paidUnits: bigint
  /** The vault that paid (the `from` of the USDC Transfer) — provenance for "paid via a capped vault". */
  from?: Address
}

/**
 * Verify, from the chain alone, that `txHash` paid `payTo` at least `minUnits` of `usdc`.
 *
 * Sums the values of USDC `Transfer(_, payTo, value)` events emitted by the canonical token
 * contract in that transaction. Because only the real USDC contract can emit those logs, a seller
 * needs no trust in the buyer — the receipt is the proof. (The vault that paid is returned so the
 * seller can show the payment came through a budget-capped AgentVault.)
 */
export async function verifyVaultPayment(p: VerifyParams): Promise<VerifyResult> {
  let receipt
  try {
    receipt = await p.publicClient.getTransactionReceipt({ hash: p.txHash })
  } catch {
    return { ok: false, reason: 'transaction not found or not yet mined', paidUnits: 0n }
  }
  if (receipt.status !== 'success') {
    return { ok: false, reason: 'payment transaction reverted on-chain', paidUnits: 0n }
  }

  const usdc = getAddress(p.usdc)
  const payTo = getAddress(p.payTo)
  let received = 0n
  let from: Address | undefined

  for (const log of receipt.logs) {
    if (getAddress(log.address) !== usdc) continue
    try {
      const ev = decodeEventLog({ abi: transferEventAbi, data: log.data, topics: log.topics })
      if (ev.eventName !== 'Transfer') continue
      const args = ev.args as unknown as { from: Address; to: Address; value: bigint }
      if (getAddress(args.to) === payTo) {
        received += args.value
        from = args.from
      }
    } catch {
      // Not a Transfer event from the USDC contract — ignore.
    }
  }

  if (received < p.minUnits) {
    return {
      ok: false,
      reason: `insufficient payment: received ${received} base units, require ${p.minUnits}`,
      paidUnits: received,
    }
  }
  return { ok: true, paidUnits: received, from }
}
