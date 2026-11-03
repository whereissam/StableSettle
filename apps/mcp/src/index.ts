#!/usr/bin/env bun
// StableSettle MCP server — arc:spawn-agent.
// Exposes tools inside Claude: spawn_agent, agent_pay, agent_pay_x402, fund_agent, topup_gas,
// get_agent, sync_allowlist_from_ens. The budget cap that makes this safe lives in AgentVault.sol on
// Arc; this server just orchestrates wallet + deploy + reads (and reads policy back from ENS).

import { existsSync, readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getAddress, isAddress } from 'viem'
import { z } from 'zod'

// Load this package's own .env regardless of the cwd the MCP client launches us from — an MCP
// client typically starts the server from the project root, where Bun's auto-load wouldn't find
// apps/mcp/.env. Real environment variables always take precedence over the file.
const envFile = new URL('../.env', import.meta.url)
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0 || line.trimStart().startsWith('#')) continue
    const key = line.slice(0, eq).trim()
    if (/^[A-Z0-9_]+$/.test(key) && !process.env[key]) process.env[key] = line.slice(eq + 1).trim()
  }
}
import {
  chainConfig,
  defaultDailyLimitBps,
  ensPolicyName,
  fromUsdcUnits,
  MAX_USDC_DOLLARS,
  ownerAddress,
  ownerPayoutAddress,
  toUsdcUnits,
} from './config.ts'
import {
  deployVault,
  deployerAddress,
  enableAllowlist,
  fundVault,
  readRecipientCap,
  readVault,
  setDailyLimit,
  setMaxPerSpend,
  setRecipientCap,
  simulateSpend,
  topUpGas,
  usdcBalanceOf,
} from './chain.ts'
import { createAgentWallet, executeSpend } from './circle.ts'
import { ensNameFor, registerEnsSubname, verifyHuman } from './identity.ts'
import { readEnsAllowlist } from './ens-read.ts'
import type { WorldIdProof } from './worldid.ts'
import { deploymentCard, spendCard, statusCard, x402Card } from './card.ts'
import { fetchWithX402 } from './x402.ts'
import { getAgent, listAgents, nullifierUsed, saveAgent, type AgentRecord } from './store.ts'
import type { ServerContext } from './users.ts'

// The McpServer is built per-connection by `buildServer()` below — one per stdio process, one per
// HTTP session — so each connection is isolated. Tool handlers are stateless (state lives on-chain
// + in the JSON store), so a fresh server per session is cheap and safe.

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] }
}

function errorText(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e)
  return { content: [{ type: 'text' as const, text: `⚠️ ${msg}` }], isError: true }
}

/**
 * Validate + checksum an address. This is a security boundary: tool args can come from a model
 * acting on prompt-injected content, so a malformed or attacker-supplied `to`/`usdc` must be
 * rejected here — never passed to a contract call on a bare `as 0x${string}` cast.
 */
function requireAddress(value: string | undefined, label: string): `0x${string}` {
  if (!value || !isAddress(value)) {
    throw new Error(`Invalid ${label} address: ${JSON.stringify(value)}. Expected a 0x-prefixed 20-byte address.`)
  }
  return getAddress(value)
}

function resolveUsdc(override?: string): `0x${string}` {
  const usdc = override ?? chainConfig().usdcAddress
  if (!usdc) throw new Error('No USDC address: set USDC_ADDRESS or pass `usdc`.')
  return requireAddress(usdc, 'USDC')
}

// The zod schemas below are kept as real values (clients receive the full JSON schema + field
// descriptions) but typed as `z.ZodRawShape` so the SDK's tool generic doesn't deeply instantiate
// (a known TS2589 with @modelcontextprotocol/sdk). Handler args are typed explicitly to compensate.

/**
 * Build a fully-configured StableSettle MCP server with all seven tools registered. Called once per
 * stdio process and once per Streamable-HTTP session, so every connection gets an isolated instance.
 */
export function buildServer(ctx?: ServerContext) {
  const server = new McpServer({ name: 'stablesettle', version: '0.1.0' })

// ── spawn_agent ──────────────────────────────────────────────────────────────

interface SpawnArgs {
  name: string
  budget: number
  usdc?: string
  fund?: number
  gas?: number
  maxPerSpend?: number
  dailyLimit?: number
  allowlist?: string[]
  worldIdProof?: string
}

const spawnInput: z.ZodRawShape = {
  name: z.string().min(1).max(64).describe('Agent label, e.g. "trader-bot". Becomes <name>.<ENS parent>.'),
  budget: z
    .number()
    .positive()
    .finite()
    .max(MAX_USDC_DOLLARS)
    .describe('Lifetime spend CAP in USDC dollars (e.g. 5000). Just an on-chain number — costs NOTHING to set high; it does not move money.'),
  usdc: z.string().optional().describe('Override the settlement token address (defaults to USDC_ADDRESS).'),
  fund: z
    .number()
    .nonnegative()
    .finite()
    .max(MAX_USDC_DOLLARS)
    .optional()
    .describe('USDC dollars to actually move into the vault now — REAL money from the deployer (default 0). Must be ≤ the deployer balance. For a test, 0.5 is plenty.'),
  gas: z
    .number()
    .nonnegative()
    .finite()
    .max(MAX_USDC_DOLLARS)
    .optional()
    .describe('USDC dollars to send the agent wallet for gas — REAL money (default 0). ~0.1 is plenty on Arc.'),
  maxPerSpend: z
    .number()
    .positive()
    .finite()
    .max(MAX_USDC_DOLLARS)
    .optional()
    .describe('Optional per-transaction ceiling in USDC dollars: no single spend may exceed this (on top of the lifetime budget). Applied only when the configured owner is the deployer.'),
  dailyLimit: z
    .number()
    .nonnegative()
    .finite()
    .max(MAX_USDC_DOLLARS)
    .optional()
    .describe('Optional rolling 24h velocity limit in USDC dollars: the agent cannot spend more than this per 24h window (auto-resets). Bounds how fast a hijacked agent can drain. Omit to apply the server default (a fraction of the budget); pass 0 to disable. Applied only when the configured owner is the deployer.'),
  allowlist: z
    .array(z.string())
    .optional()
    .describe('Optional list of recipient addresses the agent is allowed to pay. If provided, the on-chain allowlist is turned ON and these addresses approved — the agent can then pay ONLY these, so a prompt-injected agent cannot send to an attacker even within budget. Applied only when the configured owner is the deployer.'),
  // NOTE: there is deliberately NO `owner` argument. The vault owner (who can setCap/revoke/withdraw)
  // is resolved from server config (OWNER_ADDRESS), never from a tool argument — otherwise a
  // prompt-injected model could hand ownership of the vault, and its funds, to an attacker.
  worldIdProof: z
    .string()
    .optional()
    .describe('World ID proof JSON from the verify page (enables human-backed verification; signal = owner address).'),
}

server.registerTool(
  'spawn_agent',
  {
    description:
      'Spawn a compliant, budget-capped AI treasury on Arc: create an isolated Circle wallet for the ' +
      'agent, deploy an AgentVault whose spend cap is enforced on-chain, reserve an ENS identity, and ' +
      'record human authorization. Returns a Deployment Card.',
    inputSchema: spawnInput as any,
  },
  async (args: SpawnArgs) => {
    const { name, budget, usdc, fund, gas, maxPerSpend, dailyLimit, allowlist, worldIdProof } = args
    try {
      const usdcAddr = resolveUsdc(usdc)
      const deployer = deployerAddress()
      // The vault's human owner (setCap/revoke/withdraw). Resolution order, all NON-tool-argument so a
      // prompt-injected model can't redirect ownership:
      //   1. the authenticated user's own address (multi-user, non-custodial — operator is never owner)
      //   2. the server's configured OWNER_ADDRESS (single-operator)
      //   3. the deployer (local/demo default)
      const configuredOwner = ownerAddress()
      const human = ctx?.ownerAddress
        ? requireAddress(ctx.ownerAddress, 'session owner')
        : configuredOwner
          ? requireAddress(configuredOwner, 'OWNER_ADDRESS')
          : deployer
      // The sole address withdraw can ever send to. For a per-user session this is the user's OWN
      // address, so a malicious operator can never redirect a withdrawal. Config can override for the
      // single-operator case; defaults to the owner.
      const configuredPayout = ownerPayoutAddress()
      const payout = ctx?.ownerAddress
        ? human
        : configuredPayout
          ? requireAddress(configuredPayout, 'OWNER_PAYOUT_ADDRESS')
          : human
      // A per-user session must not spend the OPERATOR's deployer funds. The user funds their own vault
      // from their own wallet (the contract's public `fund()`); operator-funded `fund` is admin-only.
      if (ctx?.ownerAddress && fund && fund > 0) {
        throw new Error(
          'This is your own (user-owned) agent, so it can\'t be funded from the operator\'s treasury. ' +
            `Send USDC to the vault address directly from your wallet, or call fund_agent after it exists.`,
        )
      }

      let proofInput: WorldIdProof | undefined
      if (worldIdProof) {
        try {
          proofInput = JSON.parse(worldIdProof) as WorldIdProof
        } catch {
          throw new Error('worldIdProof must be the JSON the verify page produced.')
        }
      }

      // World ID signal is bound to the human owner's address (known up front).
      const proof = await verifyHuman(proofInput, human)
      // Sybil guard: a verified proof can back only one agent. Check BEFORE creating any Circle wallet.
      if (proof.verified && (await nullifierUsed(proof.nullifier))) {
        throw new Error('This World ID proof has already backed an agent (one human → one agent per action).')
      }

      // Pre-flight: `fund` and `gas` move REAL USDC from the deployer; `budget` is just the cap and
      // costs nothing. Check the balance BEFORE creating any wallet or deploying — so an unaffordable
      // `fund` fails with a clear message instead of a cryptic ERC20 revert that leaves an orphan vault.
      const fundUnits = fund && fund > 0 ? toUsdcUnits(fund) : 0n
      const gasUnits = gas && gas > 0 ? toUsdcUnits(gas) : 0n
      if (fundUnits + gasUnits > 0n) {
        const balance = await usdcBalanceOf(human, usdcAddr)
        if (fundUnits + gasUnits > balance) {
          throw new Error(
            `Not enough USDC to fund this spawn. Deployer ${human} holds $${fromUsdcUnits(balance)}, ` +
              `but fund ($${fund ?? 0}) + gas ($${gas ?? 0}) needs $${fromUsdcUnits(fundUnits + gasUnits)}. ` +
              `Note: \`budget\` is only the on-chain cap and costs nothing — lower \`fund\`/\`gas\` (e.g. fund=0.5 gas=0.1), ` +
              `or top up at https://faucet.circle.com.`,
          )
        }
      }

      const ensName = ensNameFor(name)
      const wallet = await createAgentWallet(name)

      const { vault, txHash } = await deployVault({
        usdc: usdcAddr,
        human,
        agent: wallet.address,
        capUnits: toUsdcUnits(budget),
        agentName: ensName,
        humanProof: proof.nullifier,
        payout,
      })

      // Apply spend limits BEFORE funding, so the vault is never funded-but-unlimited for any window.
      // setDailyLimit / setMaxPerSpend are HUMAN_OWNER_ROLE-only and the server signs as the deployer,
      // so these auto-apply only when the server IS the owner. With a separate cold owner, that owner
      // sets their own policy from their wallet (the on-chain lifetime cap + payout lock still hold).
      let policyNote = ''
      const serverOwns = human === deployer
      // Default daily velocity limit: bounds how fast a hijacked/injected agent can drain. An explicit
      // `dailyLimit` (incl. 0 to disable) overrides the server default fraction of the budget.
      const dailyBps = defaultDailyLimitBps()
      const dailyDollars = dailyLimit !== undefined ? dailyLimit : (budget * dailyBps) / 10_000
      // Validate every allowlist entry up front — a malformed/prompt-injected address must be rejected
      // here, not silently passed to the contract. Empty list = allowlist not requested.
      const allowedAddrs = (allowlist ?? []).map((a, i) => requireAddress(a, `allowlist[${i}]`))
      if (serverOwns) {
        if (dailyDollars > 0) await setDailyLimit(vault, toUsdcUnits(dailyDollars))
        if (maxPerSpend && maxPerSpend > 0) await setMaxPerSpend(vault, toUsdcUnits(maxPerSpend))
        if (allowedAddrs.length > 0) await enableAllowlist(vault, allowedAddrs)
      } else {
        const wanted: string[] = []
        if (dailyDollars > 0) wanted.push(`daily limit $${dailyDollars}`)
        if (maxPerSpend && maxPerSpend > 0) wanted.push(`per-tx limit $${maxPerSpend}`)
        if (allowedAddrs.length > 0) wanted.push(`allowlist of ${allowedAddrs.length} recipient(s)`)
        if (wanted.length) {
          policyNote = `\n\n> Spend policy (${wanted.join(', ')}) not applied: only the owner (${human}) can set it. Call setDailyLimit / setMaxPerSpend / setAllowlistEnabled+setAllowedBatch from the owner wallet.`
        }
      }

      if (fundUnits > 0n) await fundVault(vault, usdcAddr, fundUnits)
      if (gasUnits > 0n) await topUpGas(wallet.address, usdcAddr, gasUnits)

      // Issue the ENS subname now that we know the agent address + vault it points at.
      const ens = await registerEnsSubname(name, { address: wallet.address, budget: String(budget), vault })

      const record: AgentRecord = {
        name,
        ensName,
        vault,
        agentAddress: wallet.address,
        circleWalletId: wallet.walletId,
        human,
        usdc: usdcAddr,
        createdTx: txHash,
        humanProof: proof.verified ? proof.nullifier : undefined,
      }
      await saveAgent(record)

      const state = await readVault(vault)
      return text(
        deploymentCard(record, state, { ensRegistered: ens.registered, humanVerified: proof.verified }) + policyNote,
      )
    } catch (e) {
      return errorText(e)
    }
  },
)

// ── agent_pay ────────────────────────────────────────────────────────────────

interface PayArgs {
  name: string
  to: string
  amount: number
}

const payInput: z.ZodRawShape = {
  name: z.string().min(1).describe('The agent to pay from, e.g. "trader-bot".'),
  to: z.string().describe('Recipient address (0x...).'),
  amount: z.number().positive().finite().max(MAX_USDC_DOLLARS).describe('Amount in USDC dollars.'),
}

server.registerTool(
  'agent_pay',
  {
    description:
      'Have a spawned agent pay USDC from its vault. The on-chain budget cap is enforced: a payment ' +
      'that would exceed the remaining budget reverts. Returns a payment card.',
    inputSchema: payInput as any,
  },
  async (args: PayArgs) => {
    const { name, to, amount } = args
    try {
      // Validate the recipient before any spend — a prompt-injected `to` must not reach the chain.
      const recipient = requireAddress(to, 'recipient')
      const record = await getAgent(name)
      if (!record) throw new Error(`No agent named "${name}". Spawn it first with spawn_agent.`)

      // Pre-flight the spend off-chain: if a guard (budget / allowlist / velocity) would reject it,
      // surface the named reason instantly instead of waiting ~2 min for Circle to report "FAILED".
      const units = toUsdcUnits(amount)
      await simulateSpend(record.vault, record.agentAddress, recipient, units)

      const { txHash } = await executeSpend(record.circleWalletId, record.vault, recipient, units)

      const state = await readVault(record.vault)
      return text(spendCard(record, recipient, String(amount), state, txHash))
    } catch (e) {
      // An over-budget spend reverts on-chain → Circle reports FAILED → we land here. That's the cap working.
      return errorText(e)
    }
  },
)

// ── agent_pay_x402 ───────────────────────────────────────────────────────────

interface PayX402Args {
  name: string
  url: string
  maxAmount?: number
}

const payX402Input: z.ZodRawShape = {
  name: z.string().min(1).describe('The agent to pay from, e.g. "trader-bot".'),
  url: z
    .string()
    .url()
    .describe('An x402-protected endpoint (returns HTTP 402 with payment requirements), e.g. http://localhost:4021/quote/ETH-USD.'),
  maxAmount: z
    .number()
    .positive()
    .finite()
    .max(MAX_USDC_DOLLARS)
    .optional()
    .describe('Willingness-to-pay ceiling in USDC dollars. The agent refuses a quote above this BEFORE spending (guards against a hostile/over-priced endpoint). Default: no extra ceiling beyond the on-chain budget cap.'),
}

server.registerTool(
  'agent_pay_x402',
  {
    description:
      'Have a spawned agent autonomously buy from an x402-protected endpoint (HTTP 402 nanopayment). ' +
      'The agent pays by calling AgentVault.spend, so the price is charged against its on-chain budget ' +
      'cap — a purchase over the remaining budget reverts and the agent never receives the data. ' +
      'Returns the purchased response plus a payment card.',
    inputSchema: payX402Input as any,
  },
  async (args: PayX402Args) => {
    const { name, url, maxAmount } = args
    try {
      const record = await getAgent(name)
      if (!record) throw new Error(`No agent named "${name}". Spawn it first with spawn_agent.`)
      const ceilingUnits = maxAmount !== undefined ? toUsdcUnits(maxAmount) : undefined

      const result = await fetchWithX402(url, async (req) => {
        // Guardrails BEFORE any spend — these run against an endpoint the agent doesn't control,
        // so a prompt-injected or hostile quote must be rejected here, not on-chain.
        const seller = requireAddress(req.payTo, 'seller (payTo)')
        const asset = requireAddress(req.asset, 'quoted asset')
        if (asset !== getAddress(record.usdc)) {
          throw new Error(`Endpoint wants payment in ${asset}, but this agent's vault settles in ${getAddress(record.usdc)}.`)
        }
        let amountUnits: bigint
        try {
          amountUnits = BigInt(req.maxAmountRequired)
        } catch {
          throw new Error(`Endpoint quoted a non-integer price: ${JSON.stringify(req.maxAmountRequired)}.`)
        }
        if (amountUnits <= 0n) throw new Error('Endpoint quoted a non-positive price.')
        if (ceilingUnits !== undefined && amountUnits > ceilingUnits) {
          throw new Error(
            `Endpoint quoted $${fromUsdcUnits(amountUnits)} but maxAmount is $${fromUsdcUnits(ceilingUnits)} — refusing to pay.`,
          )
        }

        // Pre-flight off-chain so a budget/allowlist/velocity rejection (e.g. the seller isn't
        // allowlisted) surfaces its named reason instantly, before paying Circle to fail on-chain.
        await simulateSpend(record.vault, record.agentAddress, seller, amountUnits)

        // The payment: an on-chain AgentVault.spend. Reverts if it would cross the budget cap.
        const { txHash } = await executeSpend(record.circleWalletId, record.vault, seller, amountUnits)
        if (!txHash) throw new Error('Spend did not return a transaction hash.')
        return { txHash, paidUnits: amountUnits }
      })

      const state = await readVault(record.vault)
      return text(
        x402Card(record, {
          resource: result.requirements.resource,
          seller: result.requirements.payTo,
          amount: fromUsdcUnits(result.paidUnits),
          data: result.data,
          state,
          txHash: result.txHash,
        }),
      )
    } catch (e) {
      // An over-budget nanopayment reverts on-chain → Circle reports FAILED → we land here. Cap held.
      return errorText(e)
    }
  },
)

// ── fund_agent ───────────────────────────────────────────────────────────────

interface FundArgs {
  name: string
  amount: number
}

const fundInput: z.ZodRawShape = {
  name: z.string().min(1).describe('The agent whose vault to top up, e.g. "trader-bot".'),
  amount: z.number().positive().finite().max(MAX_USDC_DOLLARS).describe('USDC dollars to move into the vault — REAL money from the deployer.'),
}

server.registerTool(
  'fund_agent',
  {
    description:
      'Top up an existing agent\'s vault with more spendable USDC (the treasury the agent pays from). ' +
      'Moves real USDC from the deployer into the AgentVault. Does not change the budget cap. Returns the updated status.',
    inputSchema: fundInput as any,
  },
  async (args: FundArgs) => {
    const { name, amount } = args
    try {
      const record = await getAgent(name)
      if (!record) throw new Error(`No agent named "${name}". Spawn it first with spawn_agent.`)
      const units = toUsdcUnits(amount)
      const balance = await usdcBalanceOf(deployerAddress(), record.usdc)
      if (units > balance) {
        throw new Error(`Deployer holds $${fromUsdcUnits(balance)} USDC but you asked to fund $${amount}. Top up at https://faucet.circle.com.`)
      }
      await fundVault(record.vault, record.usdc, units)
      const state = await readVault(record.vault)
      return text(`## 💰 Funded \`${name}\` +$${amount} USDC\n\n${statusCard(record, state)}`)
    } catch (e) {
      return errorText(e)
    }
  },
)

// ── topup_gas ────────────────────────────────────────────────────────────────

interface GasArgs {
  name: string
  amount: number
}

const gasInput: z.ZodRawShape = {
  name: z.string().min(1).describe('The agent whose wallet to fund for gas, e.g. "trader-bot".'),
  amount: z.number().positive().finite().max(MAX_USDC_DOLLARS).describe('USDC dollars to send the agent wallet for gas — REAL money. On Arc, gas is USDC. ~0.1 is plenty.'),
}

server.registerTool(
  'topup_gas',
  {
    description:
      "Send USDC to an agent's own wallet so it can pay gas (on Arc, gas is USDC). This is separate from the " +
      'vault treasury: the wallet needs a little USDC to *call* spend(), the vault holds what it actually pays. Returns the new wallet balance.',
    inputSchema: gasInput as any,
  },
  async (args: GasArgs) => {
    const { name, amount } = args
    try {
      const record = await getAgent(name)
      if (!record) throw new Error(`No agent named "${name}". Spawn it first with spawn_agent.`)
      const units = toUsdcUnits(amount)
      const balance = await usdcBalanceOf(deployerAddress(), record.usdc)
      if (units > balance) {
        throw new Error(`Deployer holds $${fromUsdcUnits(balance)} USDC but you asked to send $${amount}. Top up at https://faucet.circle.com.`)
      }
      await topUpGas(record.agentAddress, record.usdc, units)
      const walletBal = await usdcBalanceOf(record.agentAddress, record.usdc)
      return text(`## ⛽ Topped up \`${name}\`'s gas +$${amount} USDC\n\nAgent wallet \`${record.agentAddress}\` now holds **$${fromUsdcUnits(walletBal)} USDC** for gas.`)
    } catch (e) {
      return errorText(e)
    }
  },
)

// ── get_agent ────────────────────────────────────────────────────────────────

interface GetArgs {
  name?: string
}

const getInput: z.ZodRawShape = {
  name: z.string().optional().describe('The agent name. Omit to list all spawned agents.'),
}

server.registerTool(
  'get_agent',
  {
    description:
      'Show a spawned agent: remaining budget, spend, vault balance, and status. Omit `name` to list all agents.',
    inputSchema: getInput as any,
  },
  async (args: GetArgs) => {
    const { name } = args
    try {
      if (!name) {
        const all = await listAgents()
        if (!all.length) return text('No agents spawned yet. Use spawn_agent to create one.')
        return text(['## Spawned agents', '', ...all.map((a) => `- \`${a.name}\` → vault \`${a.vault}\``)].join('\n'))
      }
      const record = await getAgent(name)
      if (!record) throw new Error(`No agent named "${name}".`)
      const state = await readVault(record.vault)
      return text(statusCard(record, state))
    } catch (e) {
      return errorText(e)
    }
  },
)

// ── sync_allowlist_from_ens ────────────────────────────────────────────────────
// Tier-2: ENS is the policy SOURCE OF TRUTH. The owner publishes the approved-recipient list in an
// ENS text record; this reads it back (CCIP-Read) and writes it into the on-chain AgentVault allowlist,
// where the contract enforces it. ENS is load-bearing — pull it out and the firewall has no policy
// source. The policy ENS name comes from SERVER config (ENS_POLICY_NAME), never a tool argument, so a
// prompt-injected model can't point it at an attacker-controlled name that allowlists the attacker.

interface SyncAllowlistArgs {
  name: string
}

const syncAllowlistInput: z.ZodRawShape = {
  name: z.string().min(1).describe('The agent whose on-chain allowlist to sync from ENS, e.g. "research-bot".'),
}

server.registerTool(
  'sync_allowlist_from_ens',
  {
    description:
      "Sync an agent's on-chain recipient allowlist FROM its ENS policy record. The owner publishes the " +
      'approved recipients in an ENS text record (`stablesettle-allowlist`); this reads them back via a ' +
      'standard ENS client and writes them into the AgentVault allowlist, which the contract enforces. ' +
      'ENS is the editable policy source; the chain is the trustless gate. Returns what was synced.',
    inputSchema: syncAllowlistInput as any,
  },
  async (args: SyncAllowlistArgs) => {
    const { name } = args
    try {
      const record = await getAgent(name)
      if (!record) throw new Error(`No agent named "${name}". Spawn it first with spawn_agent.`)

      // Policy source is server-config (or the agent's own ENS name) — NEVER a tool argument.
      const policyName = ensPolicyName() ?? record.ensName
      const { addresses, raw, key } = await readEnsAllowlist(policyName)

      if (!raw) {
        throw new Error(
          `No \`${key}\` text record found on ENS name "${policyName}". Publish the approved recipients ` +
            `there (a JSON array or comma-separated list of 0x addresses), then re-run. ` +
            `This is the point: the allowlist lives in ENS, edited by the owner — not hard-coded here.`,
        )
      }
      if (addresses.length === 0) {
        throw new Error(`The \`${key}\` record on "${policyName}" had no valid addresses. Raw value: ${JSON.stringify(raw)}`)
      }

      // The on-chain allowlist is HUMAN_OWNER_ROLE-only; the server signs as the deployer, so this can
      // only apply when the server IS the owner. With a separate cold owner, return instructions instead.
      const serverOwns = getAddress(record.human) === deployerAddress()
      const list = addresses.map((a) => `\`${a}\``).join(', ')
      if (!serverOwns) {
        return text(
          `## 🏷 ENS allowlist for \`${name}\` (read-only)\n\n` +
            `Read **${addresses.length}** recipient(s) from \`${policyName}\` → \`${key}\`: ${list}\n\n` +
            `> Not applied: only the vault owner (${record.human}) can set the allowlist. Call ` +
            `\`setAllowlistEnabled(true)\` + \`setAllowedBatch([...], true)\` from the owner wallet with these addresses.`,
        )
      }

      await enableAllowlist(record.vault, addresses)
      const state = await readVault(record.vault)
      return text(
        `## 🏷 Synced \`${name}\`'s allowlist from ENS\n\n` +
          `**Source:** \`${policyName}\` → text record \`${key}\` (read live via CCIP-Read)\n\n` +
          `**Now allowed on-chain (${addresses.length}):** ${list}\n\n` +
          `The allowlist is **enforced by AgentVault** — a spend to any other address reverts ` +
          `\`RecipientNotAllowed\`, even within budget. Edit the ENS record and re-run to update it.\n\n` +
          `${statusCard(record, state)}`,
      )
    } catch (e) {
      return errorText(e)
    }
  },
)

// ── set_recipient_cap ──────────────────────────────────────────────────────────
// Granular sub-budget: bound how much a SINGLE approved recipient can receive ("vendor 0xABC ≤ $100"),
// not just the total. The allowlist says WHO may be paid; this says HOW MUCH each one gets. Enforced on
// every spend by AgentVault — over the per-recipient cap reverts RecipientCapExceeded even when the
// lifetime budget is untouched. Owner-only (HUMAN_OWNER_ROLE); the server signs as the deployer, so it
// applies only when the configured owner IS the deployer (otherwise the cold owner sets it themselves).

interface SetRecipientCapArgs {
  name: string
  recipient: string
  cap: number
}

const setRecipientCapInput: z.ZodRawShape = {
  name: z.string().min(1).describe('The agent whose vault to configure, e.g. "research-bot".'),
  recipient: z.string().describe('The recipient address (0x…) to cap. It is also approved on the allowlist in the same call.'),
  cap: z
    .number()
    .nonnegative()
    .finite()
    .max(MAX_USDC_DOLLARS)
    .describe('Per-recipient lifetime ceiling in USDC dollars — this recipient may receive at most this much total. Pass 0 to remove the sub-budget (approve without a per-recipient cap).'),
}

server.registerTool(
  'set_recipient_cap',
  {
    description:
      'Set a PER-RECIPIENT spend cap on an agent — "this vendor may receive at most $X total" — and approve ' +
      'the recipient in the same call. This is the granular complement to the allowlist: the allowlist bounds ' +
      'WHO the agent may pay, the per-recipient cap bounds HOW MUCH each one gets. Enforced on-chain by AgentVault: ' +
      'a spend over the per-recipient cap reverts (RecipientCapExceeded) even when the lifetime budget is fine. ' +
      'Owner-only — applied only when the configured owner is the deployer. Pass cap 0 to clear it.',
    inputSchema: setRecipientCapInput as any,
  },
  async (args: SetRecipientCapArgs) => {
    const { name, cap } = args
    try {
      const record = await getAgent(name)
      if (!record) throw new Error(`No agent named "${name}". Spawn it first with spawn_agent.`)
      const recipient = requireAddress(args.recipient, 'recipient')

      // HUMAN_OWNER_ROLE-only; the server signs as the deployer, so this can only apply when the server
      // IS the owner. With a separate cold owner, return instructions for the owner to run it themselves.
      const serverOwns = getAddress(record.human) === deployerAddress()
      if (!serverOwns) {
        return text(
          `## 🎯 Per-recipient cap for \`${name}\` (not applied)\n\n` +
            `Requested: \`${recipient}\` ≤ **$${cap}** total.\n\n` +
            `> Only the vault owner (${record.human}) can set it. From the owner wallet, call ` +
            `\`setAllowedWithCap(${recipient}, true, ${toUsdcUnits(cap)})\` on the vault (${record.vault}).`,
        )
      }

      const capUnits = toUsdcUnits(cap)
      await setRecipientCap(record.vault, recipient, capUnits)
      const { spent, remaining } = await readRecipientCap(record.vault, recipient)
      const state = await readVault(record.vault)
      const capLine =
        cap > 0
          ? `**\`${recipient}\` ≤ $${cap} total** (approved + capped). Spent so far: $${fromUsdcUnits(spent)} · remaining: $${fromUsdcUnits(remaining)}.`
          : `**\`${recipient}\` approved, no per-recipient cap** (bounded only by the lifetime/daily/per-tx limits).`
      return text(
        `## 🎯 Set per-recipient cap on \`${name}\`\n\n` +
          `${capLine}\n\n` +
          `Enforced by AgentVault — a spend that pushes this recipient over its cap reverts ` +
          `\`RecipientCapExceeded\`, even with lifetime budget to spare.\n\n` +
          `${statusCard(record, state)}`,
      )
    } catch (e) {
      return errorText(e)
    }
  },
)

// ── /quickstart prompt ─────────────────────────────────────────────────────────
// MCP prompts surface in Claude Code as slash commands (/mcp__stablesettle__quickstart), giving
// users a zero-docs entry point: it generates a live how-to from the registered tool descriptions.

server.registerPrompt(
  'quickstart',
  {
    title: 'StableSettle — quickstart',
    description: 'How to spawn and control a budget-capped AI treasury (no docs needed).',
  },
  () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            'Give me a quickstart for the StableSettle MCP tools. In a short bullet list, say what each ' +
            'does — spawn_agent (with budget, maxPerSpend, fund, gas), fund_agent, topup_gas, agent_pay, ' +
            'agent_pay_x402, get_agent — then show 3 example requests I can type in plain English ' +
            '(e.g. spawning a capped agent, topping it up, checking status). Keep it tight, then ask what I want to do.',
        },
      },
    ],
  }),
)

  return server
}

// ── transport bootstrap ───────────────────────────────────────────────────────
// Default: stdio (local dev / .mcp.json). Hosted: set MCP_TRANSPORT=http (or MCP_HTTP_PORT) to serve
// Streamable HTTP, so users connect with a URL and run nothing locally. See ./http.ts.
if (process.env.MCP_TRANSPORT === 'http' || process.env.MCP_HTTP_PORT) {
  const { startHttpServer } = await import('./http.ts')
  startHttpServer(buildServer)
} else {
  const transport = new StdioServerTransport()
  await buildServer().connect(transport)
  console.error('StableSettle MCP server ready (stdio).')
}
