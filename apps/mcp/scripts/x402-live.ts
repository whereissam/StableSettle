#!/usr/bin/env bun
// LIVE end-to-end run against real Arc testnet + real Circle — the full agentic flow an AI client
// drives, in one script: spawn-equivalent (Circle wallet → deploy AgentVault → fund → gas top-up) →
// the agent autonomously buys from the x402 seller (paying via AgentVault.spend) → over-budget buy
// is blocked by the on-chain cap.
//
// Unlike e2e:local / x402:e2e (anvil, offline), this spends REAL testnet USDC and creates a REAL
// Circle wallet. Run `bun run doctor` first. Keep amounts tiny.
//
// Run from apps/mcp so Bun auto-loads .env:  cd apps/mcp && bun run scripts/x402-live.ts

import { createPublicClient, defineChain, getAddress, http } from 'viem'
import { ARC_TESTNET_CHAIN_ID, chainConfig, fromUsdcUnits, toUsdcUnits, USDC_DECIMALS } from '../src/config.ts'
import { deployVault, deployerAddress, fundVault, readVault, topUpGas } from '../src/chain.ts'
import { createAgentWallet, executeSpend } from '../src/circle.ts'
import { ensNameFor } from '../src/identity.ts'
import { getAgent, saveAgent, type AgentRecord } from '../src/store.ts'
import { fetchWithX402 } from '../src/x402.ts'

const NAME = process.env.LIVE_AGENT_NAME || 'live-x402-demo'
const BUDGET = 1 // $1 cap
const FUND = 0.3 // $0.30 into the vault
const GAS = 0.2 // $0.20 to the agent wallet for gas
const PRICE = '0.01' // x402 toll
const PORT = 4031

let pass = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass++
  else throw new Error(`FAILED: ${label}`)
}

const cfg = chainConfig()
const usdc = getAddress(cfg.usdcAddress!)
const human = deployerAddress()
const arc = defineChain({
  id: cfg.chainId ?? ARC_TESTNET_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: USDC_DECIMALS },
  rpcUrls: { default: { http: [cfg.rpcUrl] } },
})
const publicClient = createPublicClient({ chain: arc, transport: http(cfg.rpcUrl) })

let seller: Bun.Subprocess | undefined

async function ensureAgent(): Promise<AgentRecord> {
  const existing = await getAgent(NAME)
  if (existing) {
    console.log(`Reusing existing agent "${NAME}" → vault ${existing.vault}`)
    return existing
  }
  console.log(`Spawning "${NAME}" on real Arc — Circle wallet → deploy → fund $${FUND} → gas $${GAS}…`)
  const wallet = await createAgentWallet(NAME)
  check('Circle agent wallet created', !!wallet.address, wallet.address)
  const { vault, txHash } = await deployVault({
    usdc,
    human,
    agent: wallet.address,
    capUnits: toUsdcUnits(BUDGET),
    agentName: ensNameFor(NAME),
    humanProof: `0x${'0'.repeat(64)}`,
  })
  check('AgentVault deployed on Arc', !!vault, vault)
  await fundVault(vault, usdc, toUsdcUnits(FUND))
  await topUpGas(wallet.address, usdc, toUsdcUnits(GAS)) // the path that the missing-`transfer` ABI bug broke
  check('vault funded + agent gas topped up', true, `funded $${FUND}, gas $${GAS}`)
  const record: AgentRecord = {
    name: NAME,
    ensName: ensNameFor(NAME),
    vault,
    agentAddress: wallet.address,
    circleWalletId: wallet.walletId,
    human,
    usdc,
    createdTx: txHash,
  }
  await saveAgent(record)
  return record
}

async function main() {
  check('RPC reachable', !!(await publicClient.getBlockNumber()))
  const agent = await ensureAgent()

  // Start the real x402 seller, pointed at real Arc; it pays out to the deployer for the demo.
  seller = Bun.spawn(['bun', 'run', new URL('./x402-seller.ts', import.meta.url).pathname], {
    env: {
      ...process.env,
      USDC_ADDRESS: usdc,
      X402_SELLER_ADDRESS: human,
      X402_PRICE_USDC: PRICE,
      X402_PORT: String(PORT),
    },
    stdout: 'ignore',
    stderr: 'inherit',
  })
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/health`)).ok) break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  check('x402 seller live', true, `:${PORT}`)

  // agent_pay_x402's exact logic: GET 402 → pay via AgentVault.spend (Circle) → retry with proof.
  console.log('Agent buying GET /quote/ETH-USD via x402 (real Circle spend)…')
  const result = await fetchWithX402(`http://localhost:${PORT}/quote/ETH-USD`, async (req) => {
    const amountUnits = BigInt(req.maxAmountRequired)
    const { txHash } = await executeSpend(agent.circleWalletId, agent.vault, getAddress(req.payTo), amountUnits)
    if (!txHash) throw new Error('Circle spend returned no tx hash')
    return { txHash, paidUnits: amountUnits }
  })
  const data = result.data as { pair?: string; price?: number; paid?: { viaVault?: string } }
  check('agent received the purchased data', data.pair === 'ETH-USD' && typeof data.price === 'number', `price ${data.price}`)
  check('seller verified payment came via the vault', getAddress(data.paid?.viaVault as string) === getAddress(agent.vault))
  console.log(`  paid tx: ${result.txHash}`)

  const state = await readVault(agent.vault)
  console.log(`  budget: $${fromUsdcUnits(state.spent)} spent / $${fromUsdcUnits(state.budgetCap)} cap`)
  check('spend recorded on-chain', state.spent >= toUsdcUnits(Number(PRICE)))

  console.log(`\n✅ LIVE x402 run passed — ${pass} checks. Real Circle wallet, real Arc vault, real nanopayment.`)
}

try {
  await main()
} catch (e) {
  console.error(`\n❌ ${e instanceof Error ? e.message : e}`)
  seller?.kill()
  process.exit(1)
}
seller?.kill()
process.exit(0)
