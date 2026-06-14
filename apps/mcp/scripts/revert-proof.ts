#!/usr/bin/env bun
// Produce a REAL, clickable on-chain revert: broadcast an over-the-per-tx-cap spend so it gets mined
// as a Failed transaction (with a hash anyone can open on the explorer) — proof the cap reverts on
// real Arc, not just in tests. Circle refuses to broadcast a reverting tx (it fails gas estimation
// first), so we sign directly with the deployer as the agent and pass a manual gas limit to skip
// estimation, forcing the node to mine the reverting call.
//
// Run from apps/mcp:  bun run scripts/revert-proof.ts
//
// Prints the vault address + the reverted tx hash. Costs only gas (a few cents of USDC on Arc); the
// per-tx check runs before the balance check, so the vault needs no funding to demonstrate the revert.

import { createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { agentVaultAbi } from '@stablesettle/shared/abi'
import { ARC_TESTNET_CHAIN_ID, chainConfig, USDC_DECIMALS } from '../src/config.ts'
import { deployVault, setMaxPerSpend } from '../src/chain.ts'

const cfg = chainConfig()
const usdc = cfg.usdcAddress!
const account = privateKeyToAccount(cfg.deployerPrivateKey)
const arc = defineChain({
  id: cfg.chainId ?? ARC_TESTNET_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: USDC_DECIMALS },
  rpcUrls: { default: { http: [cfg.rpcUrl] } },
})
const publicClient = createPublicClient({ chain: arc, transport: http(cfg.rpcUrl) })
const walletClient = createWalletClient({ account, chain: arc, transport: http(cfg.rpcUrl) })

// Deploy a vault where the deployer is BOTH human and agent, so we can sign the spend ourselves.
console.log('Deploying a per-tx-capped vault (deployer = agent, so we can sign the spend)…')
const { vault } = await deployVault({
  usdc,
  human: account.address,
  agent: account.address,
  capUnits: 2_000_000n, // $2 lifetime cap — plenty of budget, so only the per-tx cap can block this
  agentName: 'revert-proof.stablesettle.eth',
  humanProof: `0x${'0'.repeat(64)}`,
  payout: account.address,
})
console.log('vault:', vault)

await setMaxPerSpend(vault, 1_000_000n) // $1 per-transaction ceiling
console.log('per-tx cap set: $1')

// Spend $1.50 — over the $1 per-tx cap, under the $2 budget. Manual gas skips estimation, so the node
// mines the call and it reverts on-chain (a clickable "Failed" tx) instead of being rejected pre-flight.
console.log('Broadcasting a $1.50 spend (over the $1 per-tx cap)…')
const hash = await walletClient.writeContract({
  address: vault,
  abi: agentVaultAbi,
  functionName: 'spend',
  args: [account.address, 1_500_000n],
  gas: 150_000n,
})
console.log('tx broadcast:', hash)

const receipt = await publicClient.waitForTransactionReceipt({ hash })
console.log('\n────────────────────────────────────────')
console.log('status :', receipt.status, receipt.status === 'reverted' ? '✓ reverted on-chain as expected' : '✗ UNEXPECTED')
console.log('vault  :', `https://testnet.arcscan.app/address/${vault}`)
console.log('tx     :', `https://testnet.arcscan.app/tx/${hash}`)
console.log('────────────────────────────────────────')
process.exit(receipt.status === 'reverted' ? 0 : 1)
