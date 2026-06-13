// Agent identity (ENS via NameStone) and human authorization (World ID).
//
// ENS: NameStone issues gasless offchain subnames under our parent (e.g. trader-bot.stablesettle.eth)
// and serves them via a CCIP-Read offchain resolver, so they resolve on real ENS clients (viem/ethers,
// the ENS app). One-time on-chain setup: point the parent's resolver at NameStone's offchain resolver
// (see README). Per agent we make a single API call that sets the address + text records.
//
// We use ENSIP-26 (Agent Text Records, Draft) `agent-context` to describe the agent, and a custom
// `spend-policy` text record for the budget — no ENSIP standardizes agent spend policy yet, so that
// key is per ENSIP-5 (Text Records), not ENSIP-26.

import NameStone from '@namestone/namestone-sdk'
import { ARC_ENS_COIN_TYPE, ensParentName, namestoneApiKey, namestoneNetwork } from './config.ts'
import { verifyWorldIdProof, ZERO_NULLIFIER, type WorldIdProof } from './worldid.ts'

/** The agent's full ENS name, e.g. "trader-bot" -> "trader-bot.stablesettle.eth". Pure, no network. */
export function ensNameFor(label: string): string {
  return `${label}.${ensParentName()}`
}

export interface EnsResult {
  name: string
  /** True once the subname was actually issued via NameStone; false if skipped (no API key) or it errored. */
  registered: boolean
  /** Present when registration failed, for surfacing in the card without throwing. */
  error?: string
}

export interface EnsPolicy {
  /** The agent's wallet address (same on Arc and other EVM chains). */
  address: `0x${string}`
  /** Lifetime budget cap, as a human dollar string (e.g. "5000"). */
  budget: string
  /** The AgentVault address the policy is enforced by. */
  vault: `0x${string}`
}

/**
 * Issue (or overwrite) the agent's ENS subname with its address + spend-policy text records.
 * No-ops gracefully (registered: false) when NAMESTONE_API_KEY is unset, so the spawn flow still works.
 */
export async function registerEnsSubname(label: string, policy: EnsPolicy): Promise<EnsResult> {
  const name = ensNameFor(label)
  const apiKey = namestoneApiKey()
  if (!apiKey) return { name, registered: false }

  const [, ...parentParts] = name.split('.')
  const domain = parentParts.join('.')

  try {
    const ns =
      namestoneNetwork() === 'sepolia' ? new NameStone(apiKey, { network: 'sepolia' }) : new NameStone(apiKey)

    await ns.setName({
      name: label,
      domain,
      address: policy.address,
      text_records: {
        // ENSIP-26 (Agent Text Records, Draft): free-form description of the agent + its chains/tokens.
        'agent-context': `StableSettle budget-capped AI agent. Settles USDC on Arc; spend cap $${policy.budget}, enforced on-chain by AgentVault ${policy.vault}.`,
        // Spend policy: a CUSTOM ENSIP-5 text record — no ENSIP standardizes agent spend policy yet.
        'spend-policy': JSON.stringify({ budgetCap: policy.budget, vault: policy.vault, chain: 'arc-testnet' }),
        'budget-cap': policy.budget,
        'agent-vault': policy.vault,
        description: `Budget-capped AI agent · cap $${policy.budget} USDC · enforced on-chain by StableSettle`,
      },
      // Store the Arc address under its ENSIP-11 coinType too (address field already covers EVM/ETH).
      coin_types: { [ARC_ENS_COIN_TYPE]: policy.address },
    })

    return { name, registered: true }
  } catch (e) {
    return { name, registered: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface HumanProof {
  /** Nullifier hash of the World ID proof, recorded on-chain as provenance (zero if unverified). */
  nullifier: `0x${string}`
  verified: boolean
  error?: string
}

/**
 * Verify a human via World ID. Pass the IDKit proof (from the verify page) and the `signal` it was
 * bound to (the human owner's address). With no proof — or no World ID config — returns an unverified
 * zero nullifier so spawn still works; a zero proof on-chain transparently means "not yet verified".
 */
export async function verifyHuman(proof?: WorldIdProof, signal?: string): Promise<HumanProof> {
  if (!proof) return { nullifier: ZERO_NULLIFIER, verified: false }
  const r = await verifyWorldIdProof(proof, signal)
  return { nullifier: r.nullifier, verified: r.verified, error: r.error }
}
