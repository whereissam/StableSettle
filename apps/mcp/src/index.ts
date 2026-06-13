#!/usr/bin/env bun
// StableSettle MCP server — arc:spawn-agent.
// Exposes three tools inside Claude: spawn_agent, agent_pay, get_agent. The budget cap that makes
// this safe lives in AgentVault.sol on Arc; this server just orchestrates wallet + deploy + reads.

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
import { chainConfig, fromUsdcUnits, MAX_USDC_DOLLARS, toUsdcUnits } from './config.ts'
import { deployVault, deployerAddress, fundVault, readVault, setMaxPerSpend, topUpGas, usdcBalanceOf } from './chain.ts'
import { createAgentWallet, executeSpend } from './circle.ts'
import { ensNameFor, registerEnsSubname, verifyHuman } from './identity.ts'
import type { WorldIdProof } from './worldid.ts'
import { deploymentCard, spendCard, statusCard, x402Card } from './card.ts'
import { fetchWithX402 } from './x402.ts'
import { getAgent, listAgents, nullifierUsed, saveAgent, type AgentRecord } from './store.ts'

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
 * Build a fully-configured StableSettle MCP server with all six tools registered. Called once per
 * stdio process and once per Streamable-HTTP session, so every connection gets an isolated instance.
 */
export function buildServer() {
  const server = new McpServer({ name: 'stablesettle', version: '0.1.0' })

// ── spawn_agent ──────────────────────────────────────────────────────────────

interface SpawnArgs {
  name: string
  budget: number
  usdc?: string
  fund?: number
  gas?: number
  maxPerSpend?: number
  owner?: string
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
    .describe('Optional per-transaction ceiling in USDC dollars: no single spend may exceed this (on top of the lifetime budget). Set from the owner — applied only when `owner` is the deployer (the default).'),
  owner: z
    .string()
    .optional()
    .describe('Human-owner address that controls the vault (setCap/revoke/withdraw). Defaults to the server deployer. Pass the connecting user\'s address to make them the owner.'),
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
    const { name, budget, usdc, fund, gas, maxPerSpend, owner, worldIdProof } = args
    try {
      const usdcAddr = resolveUsdc(usdc)
      const deployer = deployerAddress()
      // The vault's human owner. Defaults to the server deployer; pass `owner` to hand control to the
      // connecting user (they can then setCap/revoke/withdraw from their own wallet).
      const human = owner ? requireAddress(owner, 'owner') : deployer

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
      })

      if (fundUnits > 0n) await fundVault(vault, usdcAddr, fundUnits)
      if (gasUnits > 0n) await topUpGas(wallet.address, usdcAddr, gasUnits)

      // Per-transaction ceiling. setMaxPerSpend is HUMAN_OWNER_ROLE-only, and the server signs as the
      // deployer — so we can only set it here when the owner IS the deployer. With a custom owner, the
      // user sets it themselves from their wallet (or via a future owner-authenticated path).
      let perSpendNote = ''
      if (maxPerSpend && maxPerSpend > 0) {
        if (human === deployer) {
          await setMaxPerSpend(vault, toUsdcUnits(maxPerSpend))
        } else {
          perSpendNote = `\n\n> Per-tx limit of $${maxPerSpend} not applied: only the owner (${human}) can set it. Call setMaxPerSpend from the owner wallet.`
        }
      }

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
        deploymentCard(record, state, { ensRegistered: ens.registered, humanVerified: proof.verified }) + perSpendNote,
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

      const { txHash } = await executeSpend(record.circleWalletId, record.vault, recipient, toUsdcUnits(amount))

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
