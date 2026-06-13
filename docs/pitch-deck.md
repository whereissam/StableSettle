# StableSettle — Pitch Deck

> Budget-capped AI treasuries for programmable stablecoin settlement, on Arc.
> One command spawns an AI agent with a wallet, an identity, a human-backed authorization,
> and a spending limit it **cannot** exceed — because the limit is enforced in Solidity.

*Speaker-ready Markdown slides. Each `---` is one slide. ~5 minute pitch.*

---

## 1 · StableSettle

### Spawn a budget-capped AI treasury in 15 seconds.

Built on **Arc** with **Circle** wallets, **ENS** identity, **World ID** authorization, and a **Solidity-enforced USDC spending limit**.

> *AI agents can hold and spend stablecoins — but they cannot overspend, because the budget cap is enforced on-chain.*

---

## 2 · The problem

**2026: everyone wants AI agents that can pay. Almost everyone built a naive transfer bot.**

Giving an AI agent direct access to money is dangerous:

- 🔑 **API keys leak** — and the agent's wallet holds the funds.
- 🧱 **Backend spend limits get bypassed** — SSRF, a leaked key, or a direct on-chain tx.
- 📊 **Dashboards detect overspending *after* it happens.**
- 🪪 **Identity & compliance are bolted on last,** if ever.

The limit is always a *soft check sitting outside the money.*

---

## 3 · Where the limit lives — the attack surface

```
❌ Raw key + funds        Agent holds key + USDC   → key leaks → everything drained
⚠️ Backend / dashboard    Limit on your server     → bypass API → overspent, caught too late
✅ StableSettle           USDC in AgentVault;       → key leaks → spend() over cap REVERTS
                          agent only has a role
```

In the first two, the limit is advisory. In StableSettle the **funds never leave the vault**, the agent only holds permission to *request* a spend, and the contract checks the cap **before any transfer**.

> Even a fully compromised agent key **cannot exceed the cap.**

> **An AI agent without a human is an on-chain liability. An AI agent with StableSettle is the extension of a verified human — World ID proves *who is accountable*, ENS proves *what it's authorized to do*.**

---

## 4 · The solution — `arc:spawn-agent`

One command, inside Claude, that used to be four tabs of manual setup:

```
/arc:spawn-agent --name trader-bot --budget 5000

  [1/4] 🔑  Isolated agent wallet (Circle) ............ 0xAgent…
  [2/4] 🏦  Budget-capped vault deployed on Arc ....... 0xVault…   cap $5,000 USDC
  [3/4] 🏷   trader-bot.stablesettle.eth + policy in ENS text records
  [4/4] 🌍  World ID scan — human-backed ............. ✓

  Deployment Card → agent identity · vault cap $5,000 · human verified ✓
```

An AI agent with an **independent identity, a human-backed authorization, an isolated wallet, and an on-chain budget** — born in ~15 seconds.

---

## 5 · The wow moment

Make the agent spend **$5,001** from a **$5,000** vault.

```
It does not warn.
It does not flag.
It does not rely on backend logic.

The transaction REVERTS on-chain →  BudgetExceeded(5001, 5000)
```

The limit is a `require` in Solidity, not a number on a dashboard. *Proven by 76 contract tests and a one-command local end-to-end run.*

---

## 6 · How it works — every layer earns its place

| Layer | Tech | Why it belongs |
|---|---|---|
| **Identity** | ENS subname + ENSIP-26 agent records | Human-readable identity (`agent-context`); spend policy in a custom text record |
| **Authorization** | World ID (AgentKit pattern) | A verified human delegates personhood to the agent; the nullifier is anchored on-chain |
| **Wallet** | Circle Developer-Controlled Wallet | Isolated server wallet the agent signs with, on Arc |
| **Budget** | `AgentVault` on Arc | `spend()` reverts above the cap — enforced, not flagged |
| **Settlement** | `StableSettleEscrow` | Multi-party payouts, refund reserves, disputes |
| **Interface** | MCP | Spawn & control the agent from inside Claude |

These aren't bolted-on sponsor logos — they're the parts of a *compliant* treasury.

---

## 7 · Architecture

```
Claude ──(MCP: spawn_agent / agent_pay / get_agent)──▶ MCP server
                                                          │
                         create isolated wallet ──────────┼──▶ Circle
                         deploy + read vault ─────────────┼──▶ AgentVault ◀─ agent signs spend()
                         issue subname + policy ──────────┼──▶ ENS (NameStone)
                         verify human ────────────────────┴──▶ World ID (cloud) → nullifier on-chain
                                                                    │
                                              AgentVault pays through StableSettleEscrow
                                              → merchant / creator / platform / refund reserve
```

The contract is always the source of truth; the dashboard reconstructs the full audit log from on-chain events.

---

## 8 · Who uses this

| User | Use case |
|---|---|
| E-commerce merchant | Agent pays vendors, creators, logistics — within a cap |
| AI trading bot | Spends only within a daily/monthly USDC budget |
| DAO ops bot | Pays contributors with enforced limits |
| Marketplace | Splits stablecoin payments across parties |
| Enterprise finance team | Grants an AI agent limited, revocable treasury access |

The market is *anyone about to give an autonomous agent money* — and that's now.

---

## 9 · Business model

**Don't monetize the commodity. Monetize the guarantee.**

Moving stablecoins is a race to zero — the market already prices routing at **~0.01% and falling** (Blink: 0.01% → 0.0033% as volume grows). Competing there means knife-fighting Circle on price. We don't.

| Layer | What we charge | Why |
|---|---|---|
| Settlement / routing | ~0–1 bp (table stakes) | Commoditized — match the market, never the moat |
| **Safety & compliance** ⭐ | Enterprise seats | Differentiated: on-chain cap, human-backing, audit, policy controls — real pricing power |
| Yield on float | a cut of the *yield* | Idle vault USDC → RWA; never touches the budget |

The on-chain fee (`feeBps`, ≤ 1% cap, **default 0**, gated by `FEE_ADMIN_ROLE`) is built and aligned — a thin, invisible, scales-with-volume stream once GMV exists. But it's not the business; it's plumbing we can switch on without re-architecting.

> "We charge ~nothing to move the money — like everyone else. We charge for the guarantee that an AI agent **can't run off with it.**"

---

## 10 · Why we win each track

| Sponsor | Integration | Why it's core, not decorative |
|---|---|---|
| **Arc** | `AgentVault` + escrow | USDC-native programmable payments; the budget cap is *advanced stablecoin logic* enforced on-chain |
| **ENS** | `*.stablesettle.eth` subnames | Identity via ENSIP-26 agent records (`agent-context`) + a custom spend-policy record; gasless via NameStone, resolvable on real ENS clients |
| **World ID** | Cloud-verified proof (AgentKit pattern) | Human-backed agent: a verified human delegates their World ID; nullifier anchored on-chain (Arc has no Router → cloud verify is correct) |
| **Circle** | Developer-Controlled Wallets | The isolated wallet that makes "spawn an agent" real, on Circle's own chain |
| **MCP** | `arc:spawn-agent` | The whole flow as in-chat tools — meets developers where they already are |

---

## 11 · What's built (this is not vaporware)

- ✅ **`AgentVault.sol`** — budget cap + daily velocity limit + on-chain health view + capped, non-bricking protocol fee + roles + revoke. **46 tests.**
- ✅ **`StableSettleEscrow`** — multi-party settlement, disputes, duties anomaly. **82 tests repo-wide,** incl. a stateful invariant.
- ✅ **MCP server** — `spawn_agent` / `agent_pay` / `get_agent`, with address + amount validation.
- ✅ **ENS** via NameStone · ✅ **World ID** cloud verification · ✅ **Circle** agent wallets.
- ✅ **Local end-to-end** (`e2e:local`) — deploy → fund → fee → **over-budget revert**, 12/12 green.
- ✅ **Preflight doctor** for the live Arc run.
- 🔜 **Roadmap:** Unlink for financial privacy (ENS identity is public — mask the agent's balances/tx history so the backing human can't be deanonymized); professional audit before mainnet.

---

## 12 · The ask & the one-liner

We're making it safe to **let AI run a business's money** — starting with the one guarantee nobody else enforces on-chain: *an agent that provably cannot overspend.*

> **Spawn an AI agent with a wallet, identity, and on-chain spending limit — in one command.**

**StableSettle** · budget-capped AI treasuries on Arc.
