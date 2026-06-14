// Per-user owner binding for the hosted (multi-user) path. Each connecting user is identified by a
// bearer token; the token maps to the user's OWN owner address. The vault is then deployed with that
// address as `human` + `ownerPayout`, so the operator (server) is NEVER the owner — it only ever holds
// the agent's bounded spend wallet. This is what makes multi-user non-custodial: the operator cannot
// withdraw, raise the cap, or change the allowlist on a user's vault; those are owner-only, and the
// user holds the owner key (e.g. a Dynamic/Circle embedded wallet — recoverable, un-stealable).
//
// The owner is resolved from the AUTHENTICATED SESSION, never from a tool argument, so a prompt-injected
// model cannot redirect ownership. Tokens are stored hashed (never in plaintext).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { getAddress, isAddress } from 'viem'

/** Context handed to a built MCP server for one session. Empty = operator/admin (owner from config). */
export interface ServerContext {
  /** The connecting user's own owner address (vault `human` + `ownerPayout`). */
  ownerAddress?: `0x${string}`
  /** Opaque user id, for logging / records. */
  userId?: string
}

export interface UserRecord {
  userId: string
  ownerAddress: `0x${string}`
}

function storePath(): string {
  return process.env.USER_STORE_PATH || new URL('../.users.json', import.meta.url).pathname
}

/** Tokens are stored as a sha256 hash so the raw token never sits on disk. */
function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function load(): Record<string, UserRecord> {
  try {
    return existsSync(storePath()) ? (JSON.parse(readFileSync(storePath(), 'utf8')) as Record<string, UserRecord>) : {}
  } catch {
    return {}
  }
}

/** Any users registered? Used to decide whether unknown tokens should be rejected. */
export function hasUsers(): boolean {
  return Object.keys(load()).length > 0
}

/** Resolve a bearer token to its registered user (per-user owner binding). undefined if not a user token. */
export function userForToken(token: string): UserRecord | undefined {
  if (!token) return undefined
  return load()[hash(token)]
}

/** Register (or replace) a user: their token → their own owner address. For provisioning (admin/CLI). */
export function registerUser(token: string, userId: string, ownerAddress: string): UserRecord {
  if (!token) throw new Error('token is required')
  if (!isAddress(ownerAddress)) throw new Error(`Invalid ownerAddress: ${ownerAddress}. Expected a 0x 20-byte address.`)
  const store = load()
  const rec: UserRecord = { userId, ownerAddress: getAddress(ownerAddress) }
  store[hash(token)] = rec
  writeFileSync(storePath(), JSON.stringify(store, null, 2))
  return rec
}
