#!/usr/bin/env bun
// Local end-to-end test of the on-chain spine — no external services (Circle/ENS/World ID) needed.
//
// Spins up anvil, then exercises the REAL contract + viem path the MCP server uses:
//   deploy MockUSDC → deploy AgentVault (via chain.ts) → fund (via chain.ts) → set protocol fee →
//   agent spends under cap (succeeds, fee routed) → agent spends over cap (reverts) → read state.
//
// Run: bun run apps/mcp/scripts/e2e-local.ts   (or `bun --cwd apps/mcp run e2e:local`)

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getContract,
  http,
  parseEventLogs,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { agentVaultAbi, erc20Abi } from '@stablesettle/shared/abi'

// Well-known anvil accounts.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const // acct[0]
const AGENT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const // acct[1]
const PAYEE = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address // acct[2]
const PROTOCOL = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address // acct[3]
const RPC = 'http://127.0.0.1:8545'

// Point chain.ts (and config) at anvil BEFORE anything reads env.
process.env.ARC_TESTNET_RPC_URL = RPC
process.env.ARC_CHAIN_ID = '31337'
process.env.DEPLOYER_PRIVATE_KEY = DEPLOYER_KEY

const anvilChain = defineChain({
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})

const usdc = (n: number) => BigInt(n) * 1_000_000n // 6 decimals
let pass = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass++
  else throw new Error(`FAILED: ${label}`)
}

async function waitForAnvil(pc: ReturnType<typeof createPublicClient>) {
  for (let i = 0; i < 50; i++) {
    try {
      await pc.getBlockNumber()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error('anvil did not come up')
}

async function main() {
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const agent = privateKeyToAccount(AGENT_KEY)
  const publicClient = createPublicClient({ chain: anvilChain, transport: http(RPC) })
  const deployerWallet = createWalletClient({ account: deployer, chain: anvilChain, transport: http(RPC) })
  const agentWallet = createWalletClient({ account: agent, chain: anvilChain, transport: http(RPC) })

  await waitForAnvil(publicClient)

  // chain.ts reads env lazily; import after env is set.
  const { deployVault, fundVault, readVault, topUpGas, setMaxPerSpend, setRecipientCap, readRecipientCap } =
    await import('../src/chain.ts')

  // 1. Deploy MockUSDC (read the Foundry artifact) and mint to the deployer/human.
  const mockArtifact = (await Bun.file(
    new URL('../../../packages/contracts/out/MockUSDC.sol/MockUSDC.json', import.meta.url).pathname,
  ).json()) as { abi: typeof erc20Abi; bytecode: { object: `0x${string}` } }

  const usdcHash = await deployerWallet.deployContract({
    abi: mockArtifact.abi,
    bytecode: mockArtifact.bytecode.object,
    account: deployer,
  })
  const usdcReceipt = await publicClient.waitForTransactionReceipt({ hash: usdcHash })
  const usdcAddr = usdcReceipt.contractAddress!
  check('MockUSDC deployed', !!usdcAddr, usdcAddr)

  const mock = getContract({ address: usdcAddr, abi: mockArtifact.abi, client: deployerWallet })
  await publicClient.waitForTransactionReceipt({
    hash: await (mock as any).write.mint([deployer.address, usdc(1_000_000)]),
  })

  // 2. Deploy the vault via chain.ts (deployer = human + protocol/FEE_ADMIN; agent = acct[1]).
  const { vault, txHash } = await deployVault({
    usdc: usdcAddr,
    human: deployer.address,
    agent: agent.address,
    capUnits: usdc(5000),
    agentName: 'trader-bot.stablesettle.eth',
    humanProof: `0x${'0'.repeat(64)}`,
    payout: deployer.address,
  })
  check('AgentVault deployed via chain.ts', !!vault, vault)
  check('deploy tx mined', !!txHash)

  // 3. Fund the vault with 10k USDC via chain.ts.
  await fundVault(vault, usdcAddr, usdc(10_000))
  let state = await readVault(vault)
  check('vault funded', state.balance === usdc(10_000), `balance $${state.balance / 1_000_000n}`)
  check('cap set', state.budgetCap === usdc(5000))

  // 3b. Top up the agent wallet for gas (USDC is gas on Arc). Exercises chain.ts `topUpGas` —
  // the ERC-20 `transfer` path that a trimmed erc20.json once silently broke in the live spawn.
  await topUpGas(agent.address, usdcAddr, usdc(1))
  const agentGasBal = (await publicClient.readContract({
    address: usdcAddr,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [agent.address],
  })) as bigint
  check('agent gas top-up (ERC-20 transfer) works', agentGasBal === usdc(1), `agent $${agentGasBal / 1_000_000n}`)

  // 4. Set a 0.5% protocol fee (deployer holds FEE_ADMIN_ROLE).
  await publicClient.waitForTransactionReceipt({
    hash: await deployerWallet.writeContract({
      address: vault,
      abi: agentVaultAbi,
      functionName: 'setFee',
      args: [50n, PROTOCOL],
      account: deployer,
      chain: anvilChain,
    }),
  })

  // 5. Agent spends $1,000 under the cap — payee nets $995, protocol gets $5, full $1,000 counts.
  const spendHash = await agentWallet.writeContract({
    address: vault,
    abi: agentVaultAbi,
    functionName: 'spend',
    args: [PAYEE, usdc(1000)],
    account: agent,
    chain: anvilChain,
  })
  const spendReceipt = await publicClient.waitForTransactionReceipt({ hash: spendHash })
  const feeLogs = parseEventLogs({ abi: agentVaultAbi, logs: spendReceipt.logs, eventName: 'SpendFeeTaken' })

  const payeeBal = (await publicClient.readContract({
    address: usdcAddr,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [PAYEE],
  })) as bigint
  const protocolBal = (await publicClient.readContract({
    address: usdcAddr,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [PROTOCOL],
  })) as bigint

  check('agent spend under cap succeeded', payeeBal === usdc(995), `payee $${payeeBal / 1_000_000n}`)
  check('protocol fee routed (0.5%)', protocolBal === usdc(5), `protocol $${protocolBal / 1_000_000n}`)
  check('SpendFeeTaken event emitted', feeLogs.length === 1)

  state = await readVault(vault)
  check('full amount counts against budget', state.spent === usdc(1000), `spent $${state.spent / 1_000_000n}`)
  check('remaining budget correct', state.remaining === usdc(4000), `remaining $${state.remaining / 1_000_000n}`)

  // 6. Agent tries to spend $4,001 — over the $4,000 remaining → MUST revert (the headline guarantee).
  let reverted = false
  try {
    await agentWallet.writeContract({
      address: vault,
      abi: agentVaultAbi,
      functionName: 'spend',
      args: [PAYEE, usdc(4001)],
      account: agent,
      chain: anvilChain,
    })
  } catch {
    reverted = true
  }
  check('over-budget spend reverts on-chain', reverted)

  state = await readVault(vault)
  check('budget unchanged after revert', state.spent === usdc(1000))

  // 7. Per-transaction cap via chain.ts setMaxPerSpend: a single spend over the per-tx ceiling reverts,
  //    even though plenty of lifetime budget remains.
  await setMaxPerSpend(vault, usdc(100))
  state = await readVault(vault)
  check('maxPerSpend set + readable', state.maxPerSpend === usdc(100), `$${state.maxPerSpend / 1_000_000n}/tx`)
  let perTxReverted = false
  try {
    await agentWallet.writeContract({
      address: vault,
      abi: agentVaultAbi,
      functionName: 'spend',
      args: [PAYEE, usdc(200)], // under remaining budget, but over the $100 per-tx limit
      account: agent,
      chain: anvilChain,
    })
  } catch {
    perTxReverted = true
  }
  check('over per-tx-limit spend reverts on-chain', perTxReverted)

  // 8. Per-recipient sub-budget via chain.ts setRecipientCap: bound how much ONE vendor can receive.
  //    A fresh vendor capped at $50 can take $50, but a further $1 reverts RecipientCapExceeded — even
  //    though it's under the $100/tx ceiling and there's lifetime budget to spare. "Who" + "how much each".
  const VENDOR = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as Address // acct[4]
  await setRecipientCap(vault, VENDOR, usdc(50))
  let rc = await readRecipientCap(vault, VENDOR)
  check('recipient cap set + readable', rc.cap === usdc(50) && rc.remaining === usdc(50), `$${rc.cap / 1_000_000n} cap`)

  await agentWallet.writeContract({
    address: vault,
    abi: agentVaultAbi,
    functionName: 'spend',
    args: [VENDOR, usdc(50)], // exactly the per-recipient cap — succeeds
    account: agent,
    chain: anvilChain,
  })
  rc = await readRecipientCap(vault, VENDOR)
  check('spend up to recipient cap succeeds', rc.spent === usdc(50) && rc.remaining === 0n, `vendor spent $${rc.spent / 1_000_000n}`)

  let recipientCapReverted = false
  try {
    await agentWallet.writeContract({
      address: vault,
      abi: agentVaultAbi,
      functionName: 'spend',
      args: [VENDOR, usdc(1)], // tiny, well under budget + per-tx limit, but the vendor is maxed out
      account: agent,
      chain: anvilChain,
    })
  } catch {
    recipientCapReverted = true
  }
  check('over per-recipient-cap spend reverts on-chain', recipientCapReverted)
  rc = await readRecipientCap(vault, VENDOR)
  check('recipient tally unchanged after revert', rc.spent === usdc(50))

  console.log(`\n✅ Local e2e passed — ${pass} checks. The on-chain spine works end-to-end.`)
}

// Spin anvil, run, always tear down.
const anvil = Bun.spawn(['anvil', '--silent', '--host', '127.0.0.1', '--port', '8545'], {
  stdout: 'ignore',
  stderr: 'ignore',
})
try {
  await main()
} catch (e) {
  console.error(`\n❌ ${e instanceof Error ? e.message : e}`)
  anvil.kill()
  process.exit(1)
}
anvil.kill()
process.exit(0)
