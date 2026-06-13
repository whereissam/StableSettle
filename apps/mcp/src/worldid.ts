// World ID verification (cloud). Arc has no World ID Router, so we verify the proof off-chain via
// Worldcoin's cloud verify endpoint, then record the resulting nullifier hash on-chain in the vault
// as provenance that a real human authorized the agent. The nullifier is unique per (app, action);
// the spawn flow enforces one-agent-per-nullifier off-chain (see store.ts `nullifierUsed`) for Sybil
// resistance — on-chain the nullifier is provenance, not a uniqueness gate.
//
// Proofs are produced by the IDKit widget in a browser (apps/mcp/public/verify.html) — scanned with
// the World App or the simulator (https://simulator.worldcoin.org with a staging app id). The proof
// JSON is then passed into spawn_agent.

import { verifyCloudProof } from '@worldcoin/idkit-core/backend'
import { toHex } from 'viem'
import { worldIdConfig } from './config.ts'

/** The IDKit success payload, passed through from the verify page. */
export interface WorldIdProof {
  proof: string
  merkle_root: string
  nullifier_hash: string
  verification_level: string
}

export interface VerifyResult {
  /** The nullifier hash normalized to 32-byte hex, for recording on-chain. */
  nullifier: `0x${string}`
  verified: boolean
  error?: string
}

export const ZERO_NULLIFIER = `0x${'0'.repeat(64)}` as const

/** World ID nullifier_hash is a uint256 (decimal or hex). Normalize to bytes32 hex for the vault. */
function toBytes32(nullifierHash: string): `0x${string}` {
  return toHex(BigInt(nullifierHash), { size: 32 })
}

/**
 * Verify a World ID proof against our app + action. `signal` must match the value the widget signed
 * (we bind it to the human owner's address). Returns a verified nullifier, or a graceful failure.
 */
export async function verifyWorldIdProof(proof: WorldIdProof, signal?: string): Promise<VerifyResult> {
  const cfg = worldIdConfig()
  if (!cfg) {
    return { nullifier: ZERO_NULLIFIER, verified: false, error: 'World ID not configured (set WORLD_ID_APP_ID + WORLD_ID_ACTION).' }
  }
  try {
    const res = await verifyCloudProof(proof as never, cfg.appId, cfg.action, signal)
    if (!res.success) {
      return { nullifier: ZERO_NULLIFIER, verified: false, error: res.detail ?? res.code ?? 'verification failed' }
    }
    return { nullifier: toBytes32(proof.nullifier_hash), verified: true }
  } catch (e) {
    return { nullifier: ZERO_NULLIFIER, verified: false, error: e instanceof Error ? e.message : String(e) }
  }
}
