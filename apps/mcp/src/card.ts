// Renders the human-facing cards the MCP tools return: the Deployment Card after spawn_agent,
// and the Status Card from get_agent. Plain markdown so it reads well inside Claude.

import { explorerAddressUrl, explorerTxUrl, type VaultState } from './chain.ts'
import { fromUsdcUnits } from './config.ts'
import type { AgentRecord } from './store.ts'

const ZERO_PROOF = `0x${'0'.repeat(64)}`

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * Copy-paste deposit instructions. Two intentionally different buckets:
 *   - the VAULT holds the treasury, protected by the on-chain cap — fund it freely;
 *   - the AGENT WALLET holds only gas (USDC is gas on Arc) — send dust, not the treasury.
 * Send USDC from any wallet/exchange; funding an address never requires a private key.
 */
function depositBlock(record: AgentRecord): string {
  return [
    '**Add money** — send USDC from any wallet (no key needed):',
    '',
    `- 🏦 **Treasury** (the agent spends this; **capped & safe**) → \`${record.vault}\``,
    `- ⛽ **Gas** (fees only — keep it small, it's *outside* the cap) → \`${record.agentAddress}\``,
  ].join('\n')
}

export function deploymentCard(
  record: AgentRecord,
  state: VaultState,
  opts: { ensRegistered: boolean; humanVerified: boolean },
): string {
  const human = opts.humanVerified ? 'verified via World ID ✓' : 'not yet verified (roadmap)'
  const ens = opts.ensRegistered ? record.ensName : `${record.ensName} (name reserved; on-chain mint roadmap)`
  return [
    `## 🥇 Agent spawned — \`${record.name}\``,
    '',
    '| | |',
    '|---|---|',
    `| **Agent** | ${ens} · \`${short(record.agentAddress)}\` |`,
    `| **Vault** | \`${short(record.vault)}\` · cap $${fromUsdcUnits(state.budgetCap)} USDC · spent $${fromUsdcUnits(state.spent)} |`,
    `| **Human** | ${human} |`,
    `| **Token** | USDC \`${short(state.token)}\` |`,
    `| **Links** | [vault on Arc explorer ↗](${explorerAddressUrl(record.vault)}) · [deploy tx ↗](${explorerTxUrl(record.createdTx)}) |`,
    '',
    depositBlock(record),
    '',
    `The budget cap is enforced in Solidity — \`agent_pay\` above $${fromUsdcUnits(state.remaining)} remaining will *revert*.`,
  ].join('\n')
}

export function statusCard(record: AgentRecord, state: VaultState): string {
  const proofLine = state.humanProof === ZERO_PROOF ? 'not yet verified (roadmap)' : `\`${short(state.humanProof)}\``
  const perTx = state.maxPerSpend > 0n ? `$${fromUsdcUnits(state.maxPerSpend)} / tx` : 'none'
  const daily = state.dailyLimit > 0n ? `$${fromUsdcUnits(state.dailyLimit)} / 24h` : 'none'
  const allowlist = state.allowlistEnabled ? 'ON — agent can pay only approved addresses' : 'off (agent may pay any address, within budget)'
  return [
    `## \`${record.name}\` — status`,
    '',
    '| | |',
    '|---|---|',
    `| **Status** | ${state.active ? 'active ✓' : 'revoked ✗'} |`,
    `| **Budget** | $${fromUsdcUnits(state.spent)} spent / $${fromUsdcUnits(state.budgetCap)} cap · $${fromUsdcUnits(state.remaining)} remaining |`,
    `| **Extra limits** | per-tx: ${perTx} · daily: ${daily} |`,
    `| **Recipient allowlist** | ${allowlist} |`,
    `| **Vault balance** | $${fromUsdcUnits(state.balance)} USDC |`,
    `| **Agent** | ${state.agentName} · \`${short(record.agentAddress)}\` |`,
    `| **Human proof** | ${proofLine} |`,
    `| **Vault** | [\`${short(record.vault)}\` on Arc explorer ↗](${explorerAddressUrl(record.vault)}) |`,
    '',
    depositBlock(record),
  ].join('\n')
}

export function x402Card(
  record: AgentRecord,
  opts: { resource: string; seller: string; amount: string; data: unknown; state: VaultState; txHash?: string },
): string {
  // Pretty-print the purchased payload, trimmed so the card stays readable inside Claude.
  let payload = typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data, null, 2)
  if (payload.length > 600) payload = `${payload.slice(0, 600)}…`
  return [
    `## 🛰️ \`${record.name}\` bought \`${opts.resource}\` for $${opts.amount} USDC`,
    '',
    '| | |',
    '|---|---|',
    `| **Seller** | \`${short(opts.seller)}\` (x402) |`,
    `| **Paid via** | \`AgentVault.spend\` — charged against the budget cap |`,
    `| **Remaining budget** | $${fromUsdcUnits(opts.state.remaining)} of $${fromUsdcUnits(opts.state.budgetCap)} |`,
    opts.txHash ? `| **Tx** | [${short(opts.txHash)} on Arc explorer ↗](${explorerTxUrl(opts.txHash as `0x${string}`)}) |` : '',
    '',
    'Response:',
    '',
    '```json',
    payload,
    '```',
    '',
    `The nanopayment ran through the on-chain cap — a purchase above the remaining $${fromUsdcUnits(opts.state.remaining)} would have *reverted*, and the agent would never have received the data.`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function spendCard(record: AgentRecord, to: string, amount: string, state: VaultState, txHash?: string): string {
  return [
    `## 💸 \`${record.name}\` paid $${amount} USDC`,
    '',
    '| | |',
    '|---|---|',
    `| **To** | \`${short(to)}\` |`,
    `| **Remaining budget** | $${fromUsdcUnits(state.remaining)} of $${fromUsdcUnits(state.budgetCap)} |`,
    txHash ? `| **Tx** | [${short(txHash)} on Arc explorer ↗](${explorerTxUrl(txHash as `0x${string}`)}) |` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
