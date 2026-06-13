#!/usr/bin/env bun
// Preflight for a REAL Arc run. Validates env + connectivity so you know the demo will work before
// you're live. Hard requirements (RPC, deployer, USDC) fail the check; integrations (Circle, ENS,
// World ID) are reported as warnings — spawn still works without them, just with less of the story.
//
// Run: bun --cwd apps/mcp run doctor   (loads apps/mcp/.env)

import { createPublicClient, http, formatUnits, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { erc20Abi } from '@stablesettle/shared/abi'
import { ARC_TESTNET_CHAIN_ID } from '../src/config.ts'

let hardFail = false
const ok = (m: string, d = '') => console.log(`  ✓ ${m}${d ? ` — ${d}` : ''}`)
const warn = (m: string, d = '') => console.log(`  ⚠ ${m}${d ? ` — ${d}` : ''}`)
const bad = (m: string, d = '') => {
  console.log(`  ✗ ${m}${d ? ` — ${d}` : ''}`)
  hardFail = true
}

async function main() {
  console.log('StableSettle MCP — preflight\n')

  // ── Hard requirements ──────────────────────────────────────────────────────
  console.log('Chain (required):')
  const rpc = process.env.ARC_TESTNET_RPC_URL
  const key = process.env.DEPLOYER_PRIVATE_KEY
  const usdcAddr = process.env.USDC_ADDRESS as Address | undefined

  if (!rpc) bad('ARC_TESTNET_RPC_URL not set')
  if (!key) bad('DEPLOYER_PRIVATE_KEY not set')
  if (!usdcAddr) warn('USDC_ADDRESS not set', 'pass `usdc` per spawn, or set Arc USDC 0x3600…0000')

  if (rpc) {
    try {
      const pc = createPublicClient({ transport: http(rpc) })
      const chainId = await pc.getChainId()
      if (chainId === ARC_TESTNET_CHAIN_ID) ok('RPC reachable', `chainId ${chainId} (Arc testnet)`)
      else warn('RPC reachable but unexpected chainId', `${chainId} (expected ${ARC_TESTNET_CHAIN_ID})`)

      if (key) {
        const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`)
        const native = await pc.getBalance({ address: account.address })
        // On Arc, USDC is the native gas token (6 decimals at the native layer for display purposes).
        if (native > 0n) ok('deployer has gas', `${account.address}`)
        else bad('deployer has no balance for gas', account.address)

        if (usdcAddr) {
          const bal = (await pc.readContract({
            address: usdcAddr,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [account.address],
          })) as bigint
          if (bal > 0n) ok('deployer USDC balance', `$${formatUnits(bal, 6)}`)
          else warn('deployer holds 0 USDC', 'fund the vault from elsewhere or mint MockUSDC')
        }
      }
    } catch (e) {
      bad('RPC call failed', e instanceof Error ? e.message : String(e))
    }
  }

  // ── Integrations (warnings) ──────────────────────────────────────────────────
  console.log('\nCircle agent wallet (optional):')
  const circle = ['CIRCLE_API_KEY', 'ENTITY_SECRET', 'CIRCLE_BLOCKCHAIN'].filter((k) => !process.env[k])
  if (circle.length === 0) ok('Circle configured', process.env.CIRCLE_BLOCKCHAIN)
  else warn('Circle not fully configured', `missing ${circle.join(', ')} — agent wallet creation will fail`)

  console.log('\nENS via NameStone (optional):')
  if (process.env.NAMESTONE_API_KEY) ok('NameStone configured', `network ${process.env.NAMESTONE_NETWORK || 'sepolia'}`)
  else warn('NAMESTONE_API_KEY not set', 'ENS name reserved but not issued')

  console.log('\nWorld ID (optional):')
  if (process.env.WORLD_ID_APP_ID && process.env.WORLD_ID_ACTION) {
    ok('World ID configured', `${process.env.WORLD_ID_APP_ID} / ${process.env.WORLD_ID_ACTION}`)
  } else {
    warn('WORLD_ID_APP_ID / WORLD_ID_ACTION not set', 'agents recorded as not-yet-verified')
  }

  console.log(hardFail ? '\n❌ Not ready — fix the ✗ items above.' : '\n✅ Ready for a real Arc spawn.')
  process.exit(hardFail ? 1 : 0)
}

await main()
