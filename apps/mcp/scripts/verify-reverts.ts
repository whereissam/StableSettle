// Throwaway demo-verification: exercise simulateSpend against the live research-bot vault.
// Proves the firewall reverts decode to named reasons (BudgetExceeded / RecipientNotAllowed /
// DailyLimitExceeded) and that an allowed spend simulates clean — repeatably, no money moved.
import { simulateSpend } from '../src/chain.ts'
import { toUsdcUnits } from '../src/config.ts'
import { getAgent } from '../src/store.ts'

const NAME = 'research-bot'
const SELLER = '0xBBffC9264593C4A7d1A612172564536Fe851f4f6' // allowlisted
const TRUSTED = '0xf1919517D7C729e9cC0DE6d9252B4db6cC0F6808' // allowlisted
const ATTACKER = '0x000000000000000000000000000000000000dEaD' // NOT allowlisted

const rec = await getAgent(NAME)
if (!rec) throw new Error(`no agent ${NAME}`)

async function check(label: string, to: `0x${string}`, dollars: number, expectRevert: boolean) {
  try {
    await simulateSpend(rec!.vault, rec!.agentAddress, to, toUsdcUnits(dollars))
    console.log(`${expectRevert ? '❌ EXPECTED REVERT but PASSED' : '✓ OK (allowed)'} — ${label}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log(`${expectRevert ? '✓' : '❌ UNEXPECTED'} — ${label}\n      → ${msg}`)
  }
}

console.log(`vault ${rec.vault}  agent ${rec.agentAddress}\n`)
await check('budget: pay $501 to trusted (over $500 cap)', TRUSTED, 501, true)
await check('allowlist: pay $40 to attacker (not on list)', ATTACKER, 40, true)
await check('velocity: pay $60 to trusted (over $50/day)', TRUSTED, 60, true)
await check('allowed: pay $0.01 to seller (x402 toll)', SELLER, 0.01, false)
await check('allowed: pay $1 to trusted (under all limits)', TRUSTED, 1, false)
