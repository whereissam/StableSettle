// Environment configuration for the StableSettle MCP server. Validated lazily so individual
// tools can surface a precise "missing env" error rather than crashing the whole server at boot.

export const USDC_DECIMALS = 6

/** Arc testnet chain id (Circle: hex 0x4CEF52). */
export const ARC_TESTNET_CHAIN_ID = 5042002
/** ENSIP-11 coinType for Arc testnet: 0x80000000 | 5042002. Used to store the agent's Arc address in ENS. */
export const ARC_ENS_COIN_TYPE = String(0x80000000 | ARC_TESTNET_CHAIN_ID)

export interface ChainConfig {
  rpcUrl: string
  chainId: number | undefined
  deployerPrivateKey: `0x${string}`
  usdcAddress: `0x${string}` | undefined
}

export interface CircleConfig {
  apiKey: string
  entitySecret: string
  blockchain: string
  walletSetId: string | undefined
}

class MissingEnvError extends Error {
  constructor(keys: string[]) {
    super(`Missing required environment variable(s): ${keys.join(', ')}. See apps/mcp/.env.example.`)
    this.name = 'MissingEnvError'
  }
}

function require_(keys: string[]): void {
  const missing = keys.filter((k) => !process.env[k])
  if (missing.length) throw new MissingEnvError(missing)
}

export function chainConfig(): ChainConfig {
  require_(['ARC_TESTNET_RPC_URL', 'DEPLOYER_PRIVATE_KEY'])
  const key = process.env.DEPLOYER_PRIVATE_KEY as string
  return {
    rpcUrl: process.env.ARC_TESTNET_RPC_URL as string,
    chainId: process.env.ARC_CHAIN_ID ? Number(process.env.ARC_CHAIN_ID) : undefined,
    deployerPrivateKey: (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`,
    usdcAddress: process.env.USDC_ADDRESS as `0x${string}` | undefined,
  }
}

export function circleConfig(): CircleConfig {
  require_(['CIRCLE_API_KEY', 'ENTITY_SECRET', 'CIRCLE_BLOCKCHAIN'])
  return {
    apiKey: process.env.CIRCLE_API_KEY as string,
    entitySecret: process.env.ENTITY_SECRET as string,
    blockchain: process.env.CIRCLE_BLOCKCHAIN as string,
    walletSetId: process.env.CIRCLE_WALLET_SET_ID || undefined,
  }
}

export function ensParentName(): string {
  return process.env.ENS_PARENT_NAME || 'stablesettle.eth'
}

/** NameStone API key for gasless ENS subnames. Absent → ENS registration is skipped (name still reserved). */
export function namestoneApiKey(): string | undefined {
  return process.env.NAMESTONE_API_KEY || undefined
}

/** Which ENS network NameStone serves the parent on. 'sepolia' or 'mainnet' (default sepolia for the demo). */
export function namestoneNetwork(): 'sepolia' | 'mainnet' {
  return process.env.NAMESTONE_NETWORK === 'mainnet' ? 'mainnet' : 'sepolia'
}

/**
 * Tier-2 "ENS as the policy source": the ENS name whose text record holds the recipient allowlist.
 * Server config, deliberately NOT a tool argument — a prompt-injected model must not be able to point
 * the policy source at an attacker-controlled name (which could allowlist the attacker). Unset → the
 * tool falls back to the agent's own ENS name. Set e.g. to the human owner's name (alice.eth).
 */
export function ensPolicyName(): string | undefined {
  return process.env.ENS_POLICY_NAME || undefined
}

/** The ENS text-record key the recipient allowlist lives under (Tier-2 policy source). */
export function ensAllowlistRecordKey(): string {
  return process.env.ENS_ALLOWLIST_RECORD || 'stablesettle-allowlist'
}

/** RPC for READING ENS (sepolia/mainnet, per NAMESTONE_NETWORK). Optional — viem's chain default otherwise. */
export function ensReadRpcUrl(): string | undefined {
  return process.env.ENS_READ_RPC_URL || undefined
}

/** World ID app + action for cloud proof verification. Absent → human verification is skipped. */
export function worldIdConfig(): { appId: `app_${string}`; action: string } | undefined {
  const appId = process.env.WORLD_ID_APP_ID
  const action = process.env.WORLD_ID_ACTION
  if (!appId || !action) return undefined
  return { appId: appId as `app_${string}`, action }
}

export function agentStorePath(): string {
  return process.env.AGENT_STORE_PATH || new URL('../.agents.json', import.meta.url).pathname
}

/**
 * The vault's human owner (HUMAN_OWNER_ROLE: setCap / revoke / withdraw). Resolved from SERVER
 * config — deliberately NOT a tool argument, so a prompt-injected model cannot redirect ownership
 * of a vault (and the funds behind it) to an attacker. Unset → defaults to the deployer.
 */
export function ownerAddress(): string | undefined {
  return process.env.OWNER_ADDRESS || undefined
}

/**
 * The sole address a vault's `withdraw` can ever send to — a cold recovery address, fixed on-chain
 * at construction. Unset → defaults to the owner. Setting a distinct cold address means even a
 * stolen owner key can only move funds *home*, never to an attacker. Also never a tool argument.
 */
export function ownerPayoutAddress(): string | undefined {
  return process.env.OWNER_PAYOUT_ADDRESS || undefined
}

/**
 * Default 24h velocity limit applied to a freshly-spawned agent, as a fraction of its lifetime cap
 * in basis points. A new agent left with ONLY a lifetime cap can be drained in a single tricked /
 * injected payment; a daily limit bounds how fast funds can leave per 24h window (with auto-reset),
 * so a hijacked agent can't burst the whole treasury at once. Default 2000 bps = 20% (drain takes
 * ≥5 days, giving the owner time to notice and revoke). Set to 0 to disable the default entirely
 * (e.g. for a demo). Only applied automatically when the server is the vault owner; with a separate
 * cold owner, that owner sets their own policy. A per-spawn `dailyLimit` argument overrides this.
 */
export function defaultDailyLimitBps(): number {
  const raw = process.env.DEFAULT_DAILY_LIMIT_BPS
  if (raw === undefined) return 2000
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 10_000) {
    throw new Error(`DEFAULT_DAILY_LIMIT_BPS must be 0–10000 (basis points). Got: ${JSON.stringify(raw)}.`)
  }
  return Math.floor(n)
}

/** Largest dollar amount we accept — beyond this, `dollars * 1e6` loses integer precision in a JS number. */
export const MAX_USDC_DOLLARS = 9_000_000

/** USDC has 6 decimals. Convert a human dollar amount (e.g. 5000) to base units (5000_000000). */
export function toUsdcUnits(dollars: number): bigint {
  if (!Number.isFinite(dollars) || dollars < 0) {
    throw new Error(`Invalid amount: ${dollars}. Must be a finite, non-negative number of USDC dollars.`)
  }
  if (dollars > MAX_USDC_DOLLARS) {
    throw new Error(`Amount ${dollars} exceeds the safe precision limit (${MAX_USDC_DOLLARS}).`)
  }
  return BigInt(Math.round(dollars * 10 ** USDC_DECIMALS))
}

/** Format base units back to a human dollar string, e.g. 5000_000000n -> "5000". */
export function fromUsdcUnits(units: bigint): string {
  const whole = units / 10n ** BigInt(USDC_DECIMALS)
  const frac = units % 10n ** BigInt(USDC_DECIMALS)
  if (frac === 0n) return whole.toString()
  return `${whole}.${frac.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '')}`
}
