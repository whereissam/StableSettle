// Tier-2: ENS as the policy SOURCE OF TRUTH.
//
// The owner publishes an agent's recipient allowlist in an ENS text record (key `stablesettle-allowlist`).
// This module reads it back with a standard viem ENS client — CCIP-Read offchain resolvers (e.g.
// NameStone, which serves our gasless subnames) are followed automatically. The MCP then writes those
// addresses into the on-chain AgentVault allowlist, where the contract enforces them. So ENS is
// load-bearing: pull it out and the firewall has no policy source. The chain stays the trustless gate.

import { createPublicClient, getAddress, http, isAddress, type Address, type PublicClient } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { normalize } from 'viem/ens'
import { ensAllowlistRecordKey, ensReadRpcUrl, namestoneNetwork } from './config.ts'

let cached: PublicClient | null = null

/** A viem public client on the ENS network (sepolia/mainnet) — separate from the Arc client. */
function ensClient(): PublicClient {
  if (cached) return cached
  const chain = namestoneNetwork() === 'mainnet' ? mainnet : sepolia
  const rpc = ensReadRpcUrl()
  cached = createPublicClient({ chain, transport: rpc ? http(rpc) : http() })
  return cached
}

export interface EnsAllowlist {
  /** The ENS name the policy was read from. */
  name: string
  /** The text-record key read. */
  key: string
  /** Parsed, checksummed, de-duplicated recipient addresses. */
  addresses: Address[]
  /** Raw text-record value, for surfacing in the response (null when the record is absent). */
  raw: string | null
}

/**
 * Read a recipient allowlist from an ENS text record. Accepts a JSON array of addresses
 * (`["0x..","0x.."]`) or a comma/space/newline-separated list. Non-addresses are skipped.
 * Returns an empty list (not an error) when the name doesn't resolve or the record is unset,
 * so the caller can surface a clear "nothing published" message.
 */
export async function readEnsAllowlist(name: string): Promise<EnsAllowlist> {
  const key = ensAllowlistRecordKey()
  let norm: string
  try {
    norm = normalize(name)
  } catch {
    return { name, key, addresses: [], raw: null }
  }

  const raw = (await ensClient()
    .getEnsText({ name: norm, key })
    .catch(() => null)) as string | null
  if (!raw) return { name, key, addresses: [], raw: null }

  let tokens: string[]
  try {
    const parsed = JSON.parse(raw)
    tokens = Array.isArray(parsed) ? parsed.map(String) : String(parsed).split(/[\s,]+/)
  } catch {
    tokens = raw.split(/[\s,]+/)
  }

  const seen = new Set<string>()
  const addresses: Address[] = []
  for (const t of tokens) {
    const a = t.trim()
    if (!isAddress(a)) continue
    const cs = getAddress(a)
    if (seen.has(cs.toLowerCase())) continue
    seen.add(cs.toLowerCase())
    addresses.push(cs)
  }
  return { name, key, addresses, raw }
}
