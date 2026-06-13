#!/usr/bin/env bun
// Offline end-to-end test of the x402 nanopayment leg — no Circle/ENS/World ID needed.
//
// Spins anvil + the real x402 seller, then drives the full HTTP 402 round-trip the way agent_pay_x402
// does, but settling the spend with viem instead of Circle:
//   deploy MockUSDC → deploy AgentVault (cap $0.01) → fund → buyer GETs the seller (402) →
//   pays via AgentVault.spend → seller verifies the spend on-chain → returns the data →
//   a SECOND buy (now over the cap) makes the spend REVERT, so the agent never gets the data.
//
// Run: bun --cwd apps/mcp run x402:e2e

import { createPublicClient, createWalletClient, defineChain, getAddress, getContract, http, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { agentVaultAbi, erc20Abi } from '@stablesettle/shared/abi'

const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const // acct[0]
const AGENT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const // acct[1]
const SELLER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address // acct[2]
const RPC = 'http://127.0.0.1:8545'
const PORT = 4023

process.env.ARC_TESTNET_RPC_URL = RPC
process.env.ARC_CHAIN_ID = '31337'
process.env.DEPLOYER_PRIVATE_KEY = DEPLOYER_KEY

const anvilChain = defineChain({
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})

const usdc = (n: number) => BigInt(Math.round(n * 1_000_000)) // 6 decimals
let pass = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass++
  else throw new Error(`FAILED: ${label}`)
}

async function waitForUp(probe: () => Promise<unknown>, what: string) {
  for (let i = 0; i < 80; i++) {
    try {
      await probe()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`${what} did not come up`)
}

const anvil = Bun.spawn(['anvil', '--silent', '--host', '127.0.0.1', '--port', '8545'], {
  stdout: 'ignore',
  stderr: 'ignore',
})
let seller: Bun.Subprocess | undefined

async function main() {
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const agent = privateKeyToAccount(AGENT_KEY)
  const publicClient = createPublicClient({ chain: anvilChain, transport: http(RPC) })
  const deployerWallet = createWalletClient({ account: deployer, chain: anvilChain, transport: http(RPC) })
  const agentWallet = createWalletClient({ account: agent, chain: anvilChain, transport: http(RPC) })

  await waitForUp(() => publicClient.getBlockNumber(), 'anvil')

  const { deployVault, fundVault, readVault } = await import('../src/chain.ts')
  const { fetchWithX402 } = await import('../src/x402.ts')

  // 1. Deploy MockUSDC + mint to the human.
  const mockArtifact = (await Bun.file(
    new URL('../../../packages/contracts/out/MockUSDC.sol/MockUSDC.json', import.meta.url).pathname,
  ).json()) as { abi: typeof erc20Abi; bytecode: { object: `0x${string}` } }
  const usdcHash = await deployerWallet.deployContract({ abi: mockArtifact.abi, bytecode: mockArtifact.bytecode.object, account: deployer })
  const usdcAddr = (await publicClient.waitForTransactionReceipt({ hash: usdcHash })).contractAddress!
  check('MockUSDC deployed', !!usdcAddr, usdcAddr)
  const mock = getContract({ address: usdcAddr, abi: mockArtifact.abi, client: deployerWallet })
  await publicClient.waitForTransactionReceipt({ hash: await (mock as any).write.mint([deployer.address, usdc(1000)]) })

  // 2. Deploy a vault with a tiny $0.01 cap, fund it with $1 (balance is not the constraint — the cap is).
  const { vault } = await deployVault({
    usdc: usdcAddr,
    human: deployer.address,
    agent: agent.address,
    capUnits: usdc(0.01),
    agentName: 'buyer-bot.stablesettle.eth',
    humanProof: `0x${'0'.repeat(64)}`,
  })
  await fundVault(vault, usdcAddr, usdc(1))
  check('vault deployed + funded', !!vault, `cap $0.01, balance $1`)

  // 3. Start the real x402 seller, priced at $0.01.
  seller = Bun.spawn(['bun', 'run', new URL('./x402-seller.ts', import.meta.url).pathname], {
    env: {
      ...process.env,
      USDC_ADDRESS: usdcAddr,
      X402_SELLER_ADDRESS: SELLER,
      X402_PRICE_USDC: '0.01',
      X402_PORT: String(PORT),
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await waitForUp(async () => {
    const r = await fetch(`http://localhost:${PORT}/health`)
    if (!r.ok) throw new Error('not ready')
  }, 'x402 seller')
  check('x402 seller live', true, `:${PORT}`)

  // The buyer's pay() — the offline analogue of agent_pay_x402: spend via the agent wallet, return the tx.
  const buy = (path: string) =>
    fetchWithX402(`http://localhost:${PORT}${path}`, async (req) => {
      const amountUnits = BigInt(req.maxAmountRequired)
      const hash = await agentWallet.writeContract({
        address: vault,
        abi: agentVaultAbi,
        functionName: 'spend',
        args: [getAddress(req.payTo), amountUnits],
        account: agent,
        chain: anvilChain,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('spend reverted')
      return { txHash: hash, paidUnits: amountUnits }
    })

  // 4. Happy path: pay $0.01, get the quote.
  const result = await buy('/quote/ETH-USD')
  const data = result.data as { pair?: string; price?: number; paid?: { viaVault?: string } }
  check('buyer received the purchased data', data.pair === 'ETH-USD' && typeof data.price === 'number', `price ${data.price}`)
  check('seller saw the payment came via the vault', getAddress(data.paid?.viaVault as string) === getAddress(vault))

  const state = await readVault(vault)
  check('budget fully consumed by the nanopayment', state.remaining === 0n, `remaining $${Number(state.remaining) / 1e6}`)

  // 5. Over-budget: the cap is now exhausted, so the next x402 buy's spend MUST revert — and because
  //    the spend reverts, the buyer never sends a valid X-PAYMENT, so it never receives the data.
  let blocked = false
  try {
    await buy('/quote/BTC-USD')
  } catch {
    blocked = true
  }
  check('over-budget x402 buy is blocked by the on-chain cap', blocked)
  const after = await readVault(vault)
  check('budget unchanged after the blocked buy', after.spent === usdc(0.01))

  console.log(`\n✅ x402 e2e passed — ${pass} checks. Agentic nanopayments settle through the budget cap.`)
}

try {
  await main()
} catch (e) {
  console.error(`\n❌ ${e instanceof Error ? e.message : e}`)
  seller?.kill()
  anvil.kill()
  process.exit(1)
}
seller?.kill()
anvil.kill()
process.exit(0)
