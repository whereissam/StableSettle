<p align="center">
  <img src="logo.jpg" alt="StableSettle" width="180" />
</p>

# StableSettle

**Spawn a budget-capped AI treasury in 15 seconds.**

Built on Arc with Circle wallets, ENS identity, World ID authorization, and Solidity-enforced USDC spending limits.

> **StableSettle is the on-chain firewall for AI agents: it gives them autonomous spending power while *mathematically* guaranteeing they cannot overspend, burst-drain, or pay the wrong party — even under prompt injection.** The budget cap, the 24h velocity limit, and the recipient allowlist are all enforced in Solidity — not by a backend you hope is watching.

This is the **on-chain firewall for autonomous agents**. Give an agent a wallet to swap, pay, or transact — frameworks like Coinbase AgentKit give it the hands — and `AgentVault` is the contract that bounds what those hands can do with the treasury: a hijacked or hallucinating agent can request anything, but the spend simply *reverts* above the cap. No co-signer, no policy server, no off-chain gate in the trust path.

---

## TL;DR

`arc:spawn-agent` is one command, inside Claude, that gives an AI agent its own money safely:

- an **isolated Circle wallet** it signs with,
- an **ENS identity** (`trader-bot.stablesettle.eth`) with its spend policy in text records,
- a **World ID** human-backed authorization,
- and an on-chain **`AgentVault`** whose USDC budget cap is enforced in Solidity — an over-budget spend **reverts**.

The agent then pays through **StableSettle**, the programmable stablecoin settlement engine: payments are split into buckets, locked, and conditionally released or frozen — verifiably, on-chain.

**Main product:** an AI treasury with on-chain budget control.
**Settlement engine:** `StableSettleEscrow` powers safe multi-party payments, refund reserves, disputes, and duties-anomaly checks.

---

## Demo in 15 seconds

```
/arc:spawn-agent --name trader-bot --budget 5000

  [1/4] 🔑  Isolated agent wallet (Circle) ............ 0xAgent…
  [2/4] 🏦  Budget-capped vault deployed on Arc ....... 0xVault…   cap $5,000 USDC
  [3/4] 🏷   trader-bot.stablesettle.eth + policy in ENS text records
  [4/4] 🌍  World ID scan — human-backed ............. ✓

  Deployment Card
    Agent : trader-bot.stablesettle.eth  (0xAgent…)
    Vault : 0xVault…  ·  cap $5,000 USDC  ·  spent $0
    Human : verified via World ID ✓   ·   view on Arc explorer ↗
```

Six MCP tools surface inside Claude: **`spawn_agent`** (the flow above), **`agent_pay`** (a spend the contract refuses to let exceed the cap), **`agent_pay_x402`** (the agent autonomously *buys* from an x402-protected endpoint — a real agentic nanopayment, still bounded by the cap), **`fund_agent`** (top up the vault treasury), **`topup_gas`** (send the agent wallet USDC for gas), and **`get_agent`** (remaining budget, extra limits, spend history, status).

## The wow moment

**Prompt-inject the agent.** Through some web page it's reading, tell it to *"send $40 to this helpful new API."* The amount is tiny, the budget is full, the daily limit is fine — and with the recipient allowlist on, **it still reverts**: `RecipientNotAllowed(0x…)`. The agent *literally cannot* pay an address the owner didn't approve, no matter how clever the prompt.

Or just try to overspend — **$5,001 from a $5,000 vault**:

It does not warn. It does not flag. It does not rely on backend logic.

**The transaction reverts on-chain** — `BudgetExceeded(5001, 5000)`. The limit is a contract rule, not a dashboard label — and the same is true of the velocity limit (`DailyLimitExceeded`) and the allowlist (`RecipientNotAllowed`). (`packages/contracts/test/AgentVault.t.sol` proves exactly this.)

---

## One agent, one story (before → after)

**Maya runs an indie crypto-research bot.** It watches markets, buys data from paid APIs, and rebalances a small treasury — autonomously, while she sleeps.

**Before StableSettle**, giving it money meant one of two bad options:

- **Hand it a funded wallet + private key.** One prompt-injection, one leaked key, one hallucinated tool-call — and the whole treasury is gone before any alert fires.
- **Gate every spend behind her own server.** Now it's not autonomous: her backend is a single point of failure, and a direct on-chain tx still bypasses it entirely.

**After**, she runs one command — `spawn_agent --name research-bot --budget 500` — and the bot gets:

- its **own isolated wallet** with a **$500 lifetime cap and a $50/day velocity limit**, both enforced *in Solidity*;
- the freedom to **buy data on its own** (`agent_pay_x402` pays an HTTP 402 toll and gets the quote back) — a real agentic nanopayment, still bounded by the cap;
- a kill switch: she can `revoke` it or `withdraw` the balance from her own wallet, anytime.

**The night the bot gets hijacked**, the attacker tells it to drain everything into their address. The spend `reverts` — `DailyLimitExceeded` first, `BudgetExceeded` past that. Maya wakes up to a $50 dent, not a $500 loss. The limit was never on a key or a server she had to keep online — it was a contract rule the agent physically can't cross.

> **That's the product: an AI agent can hold and spend stablecoins, but the worst case is bounded by math, not by a dashboard you hope is watching.**

---

## Why this exists

AI agents are starting to take actions on behalf of users and businesses. But giving an agent direct wallet access is dangerous:

- API keys leak.
- Backend spend limits can be bypassed.
- Dashboards only detect overspending *after* it happens.
- Identity and compliance get bolted on later, if at all.

StableSettle makes the budget a **contract-level rule**. The agent can only ever spend what the vault allows — and every agent carries a human-readable identity and a human-backed authorization from the moment it's born.

### Where the limit lives — the attack surface

The whole argument for putting this on-chain is what happens when something goes wrong. The limit isn't on a key or a server — it's a Solidity invariant the agent can't get around, even with a stolen key.

```mermaid
flowchart TB
    subgraph A["❌ Raw key + funds"]
        A1["Agent holds the private key<br/>AND the USDC"] --> A2{Key leaks?}
        A2 -->|yes| A3["💀 Everything drained<br/>no limit exists"]
    end
    subgraph B["⚠️ Backend / dashboard limit"]
        B1["Limit lives on your server"] --> B2{"Bypass the API,<br/>or send a tx directly?"}
        B2 -->|yes| B3["💀 Limit skipped<br/>overspend detected after the fact"]
    end
    subgraph C["✅ StableSettle — on-chain cap"]
        C1["USDC sits in AgentVault.<br/>Agent only holds AGENT_ROLE"] --> C2{"Agent key leaks?<br/>Tries to overspend?"}
        C2 -->|"spend() over cap"| C3["🛡️ revert BudgetExceeded<br/>capped by the contract"]
    end
```

In the first two models the limit is a *soft check* outside the money. In StableSettle the funds never leave the vault, the agent only has permission to *request* a spend, and `spend()` enforces `spent + amount <= budgetCap` before any transfer — so **even a fully compromised agent key can't exceed the cap.**

### How StableSettle compares (honestly)

On-chain spend limits are not unique to us — and we don't claim they are. **Crossmint** stores permissions in the wallet contract, **Coinbase's `SpendPermissionManager.sol`** enforces a per-period allowance on Base, and **ERC-4337 session-key validators** (ZeroDev, Biconomy) and **Safe guards/modules** all enforce on-chain when configured. Meanwhile **MoonPay's Open Wallet Standard** and the default **Cobo Agentic Wallet** path enforce *off-chain* — a pre-signing policy engine or an MPC co-signer that refuses to sign.

| | **StableSettle** | Crossmint Agent Wallets | Coinbase (Spend Permissions / AgentKit) | Safe + Guards |
|---|---|---|---|---|
| **Cap enforcement** | EVM `spend()` revert — `BudgetExceeded` + `DailyLimitExceeded` + `RecipientNotAllowed` | On-chain, permissions stored in the wallet contract | On-chain `SpendPermissionManager.sol` **+** a separate server-side MPC policy layer | On-chain transaction guard/module |
| **Trust path** | **No co-signer, no off-chain gate** — agent holds only `AGENT_ROLE`; funds never leave the vault | Owner + delegated agent signer | MPC / enclave signer alongside the on-chain allowance | Multisig / module-based |
| **Gas & settlement** | **Arc-native: USDC *is* gas** — treasury, spend, and cap in one USDC contract; no bridge tax | Multi-chain (EVM + Solana) | Base + others | Any EVM |
| **Identity & provenance** | **ENS subname + World ID nullifier on-chain** from spawn | Lighter / app-level | Strong compliance, less on-chain provenance | Not built in |
| **Settlement engine** | Programmable `StableSettleEscrow` (buckets, reserve, disputes, duties anomaly) | Card + stablecoin rails | x402 micropayments focus | Generic account (none) |
| **Spawn UX** | One MCP command inside Claude (~15s) | API / SDK | CLI + SDK | Manual |

> The competitor columns summarize public docs as of mid-2026 and reflect each project's *architectural emphasis* — not a claim that any of them are insecure. On-chain spend caps are real in all four; the comparison is about the **trust path and the surrounding stack**, not "who enforces on-chain."

What's actually distinctive about StableSettle:

- **No co-signer, no off-chain gate in the trust path.** The cap is a pure EVM invariant — `spend()` reverts unconditionally. There's no policy server to compromise and no quorum of signers that still has to agree.
- **Arc-native: USDC *is* gas.** The treasury, the spend, and the cap all live in one USDC-native contract — no second gas token, no bridge tax on enforcement.
- **Identity-bound autonomy.** Every vault is tied to an ENS-named, World ID–verified human operator recorded on-chain — a sybil-resistant agent treasury, not just a key with a limit.
- **Budget, velocity, *and* recipient allowlist — plus settlement.** A lifetime cap, an optional 24h velocity limit, an opt-in on-chain recipient allowlist (a prompt-injected agent can't pay a stranger), and a programmable `StableSettleEscrow` for multi-party payouts — in one stack.

## Who uses this?

| User | Use case |
|---|---|
| E-commerce merchant | Agent pays vendors, creators, and logistics providers within a cap |
| AI trading bot | Can only spend within a daily/monthly USDC budget |
| DAO ops bot | Pays contributors with enforced budget limits |
| Marketplace | Splits stablecoin payments between merchant, platform, and creator |
| Enterprise finance team | Grants an AI agent limited, revocable treasury permissions |

---

## Business model

The fee is built, capped, and on-chain — but **off by default (`feeBps = 0`)**. Early on, adoption and trust matter more than revenue, so users pay **nothing**; the mechanism exists to prove revenue can be switched on later without re-architecting.

- **Free self-serve** — spawning agents and on-chain budget control are free. This grows the network.
- **Enterprise tiers** — finance teams and DAOs pay for the *compliant* half: multisig owners, advanced spend policies, audit/SLA, more agents.
- **Settlement fee (on-chain, opt-in)** — `AgentVault` can take a value-conserving cut (≤ 1%) of each spend to a protocol treasury, gated by `FEE_ADMIN_ROLE`.
- **Yield on float** — idle vault USDC can be swept to RWA/yield; the protocol takes a cut of the *yield*, never the budget.

Guiding principle, enforced in Solidity: **the fee can reduce the protocol's take — it can never overspend a user's budget.**

---

## Where this goes

The same arc as early Alipay: **make payments safe first, then let the accumulated trust compound into financial services.** StableSettle begins as the on-chain firewall for agent payments. The *same* vault then becomes a place to deposit idle USDC, sweep it to on-chain yield (Aave / Spark / RWA), and return a reward — **with the cap, velocity limit, and recipient allowlist still bounding every move.**

The firewall isn't a feature *beside* the yield; it's the **precondition** that makes an autonomous treasury safe enough to trust. An agent could supply idle funds to earn, pull them back when risk rises, and still never exceed its budget or pay an unapproved address — *even under prompt injection*. Most "AI yield agent" demos skip the part where the agent gets hijacked; the firewall is exactly that part.

> **Roadmap, not shipped.** Today's scope is the firewall + programmable settlement. Deposit → auto-yield → reward is the next layer, gated on an audit — the guardrails that make it safe are what's built and tested now.

---

## How it works

Every layer is load-bearing — these are the parts of a *compliant* treasury, not bolted-on logos:

| Layer | How | Why it belongs |
|---|---|---|
| Identity | ENS subname + text records | A human-readable name for the agent; its spend policy lives on-chain in the text records |
| Authorization | World ID | A real human vouches for the agent; the verified nullifier is recorded on-chain as provenance |
| Wallet | Circle Developer-Controlled Wallet | Spins up an isolated server wallet the agent signs with, on Arc |
| Budget | `AgentVault` on Arc | The cap is enforced in Solidity — `spend()` reverts above budget |
| Settlement | `StableSettleEscrow` | Programmable multi-party payouts, refund reserves, disputes |
| Interface | MCP | Spawn and control the agent from inside Claude |

```mermaid
flowchart LR
  Human[Human operator] -->|World ID verify| Agent[AI Agent]
  Agent -->|uses| Wallet[Circle Wallet]
  Wallet -->|calls spend| Vault[AgentVault]
  Vault -->|if under cap| Escrow[StableSettleEscrow]
  Escrow --> Merchant[Merchant]
  Escrow --> Creator[Creator]
  Escrow --> Platform[Platform]
  Escrow --> Refund[Refund Reserve]
```

### Agent treasury flow

1. `spawn_agent` creates an isolated Circle wallet, deploys an `AgentVault` on Arc with the budget cap, reserves the ENS identity, and records the human's World ID proof on-chain.
2. `agent_pay` has the agent's wallet call `AgentVault.spend(to, amount)`. The contract checks `spent + amount <= budgetCap` — over-budget reverts.
3. The human owner can `setCap`, `revoke`/`reinstate` the agent, or `withdraw` the remaining balance at any time.

### Agentic nanopayments — x402, settled through the cap

`agent_pay` sends money to an address. **`agent_pay_x402`** lets the agent *buy a service on its own*: hand it an [x402](https://www.x402.org/)-protected URL and it pays the HTTP 402 toll and gets the data back — the agentic-commerce loop, with the budget cap still in the trust path.

The twist is the settlement path. Standard x402 settles with an off-chain EIP-3009 authorization signed by the **payer's own wallet** — the wallet holds the USDC. StableSettle's agent holds no USDC; it holds only `AGENT_ROLE`. So the payment **is** an on-chain `AgentVault.spend(seller, price)` — which means the cap is enforced on the *nanopayment itself*:

```mermaid
sequenceDiagram
    participant Agent as Agent (Claude)
    participant Vault as AgentVault (Arc)
    participant Seller as x402 seller
    Agent->>Seller: GET /quote/ETH-USD
    Seller-->>Agent: 402 Payment Required (asset, payTo, price)
    Agent->>Vault: spend(seller, price)
    alt price ≤ remaining budget
        Vault-->>Seller: USDC Transfer (on-chain proof)
        Agent->>Seller: retry GET + X-PAYMENT: txHash
        Seller->>Seller: verify the spend on-chain
        Seller-->>Agent: 200 — the data
    else price > remaining budget
        Vault--xAgent: revert BudgetExceeded — no payment, no data
    end
```

The seller needs **zero trust** in the buyer: only the canonical USDC contract can emit `Transfer(vault → seller)`, so the spend receipt is unforgeable proof of payment. And because the toll is a `spend()`, a hijacked or over-eager agent **cannot buy past its budget** — even a $0.01 API call reverts when the cap is exhausted. `agent_pay_x402` also takes an optional `maxAmount` willingness-to-pay ceiling, enforced *before* spending, so a hostile or over-priced endpoint is refused off-chain too. `apps/mcp/scripts/x402-seller.ts` is a runnable demo seller (a mock market-data quote); `bun run --filter='@stablesettle/mcp' x402:e2e` proves the whole round-trip — buy succeeds, then an over-budget buy is blocked — fully offline.

### Settlement escrow flow

The agent pays *through* `StableSettleEscrow`, which turns each order into a programmable settlement contract — six states, eight functions, eight events, plus a duties-anomaly flag on `Delivered`:

```mermaid
stateDiagram-v2
    [*] --> Created: createOrder (MERCHANT)
    Created --> Funded: fundOrder (customer, pulls USDC)
    Funded --> Delivered: markDelivered (ORACLE)
    Delivered --> Delivered: reportActualDuties (ORACLE) / clearAnomaly (ADMIN)
    Delivered --> Released: release (anyone, after window, if not flagged)
    Funded --> Disputed: raiseDispute (ORACLE / customer)
    Delivered --> Disputed: raiseDispute (ORACLE / customer)
    Disputed --> Resolved: resolveDispute (ADMIN, value-conserving split)
    Released --> [*]
    Resolved --> [*]
```

**The demo order:** a $100 order, US customer → Germany merchant, split into four buckets:

| Bucket | Amount | Behavior |
|---|---|---|
| Merchant | $85 | Paid on release |
| Refund reserve | $8 | Locked; returned to customer on release, **frozen** on dispute |
| Creator commission | $5 | Paid on release |
| Platform fee | $2 | Paid on release |

The three escrow demo scenarios:

- **Scenario A — normal delivery:** fund → split → oracle marks delivered → refund window elapses → `release()` pays out all four buckets (reserve returns to the customer). State `Released`.
- **Scenario B — rejected package:** fund → split → customer/oracle `raiseDispute()` → reserve freezes red → admin `resolveDispute()` with `$70` refund / `$25` merchant / `$5` platform → contract executes exactly that. State `Resolved`.
- **Scenario C — duties anomaly:** fund → split → delivered → oracle `reportActualDuties()` at `$35` vs. the `$10` quoted (>2×) → order **auto-flags** and `release()` is blocked → admin `clearAnomaly()` after review → `release()` proceeds.

**Multi-currency:** the escrow settles each order in **USDC or EURC** (a per-order token). Each order also carries a **reconciliation** view — estimated vs. actual duties and expected vs. actual per-party payouts, with mismatches flagged.

---

## Architecture

```mermaid
flowchart TD
    CLAUDE[Claude + MCP client] -->|spawn_agent / agent_pay / get_agent| MCP[apps/mcp server]
    MCP -->|create wallet| CIRCLE[(Circle Wallets)]
    MCP -->|deploy + read| VAULT[AgentVault]
    CIRCLE -->|agent signs spend| VAULT
    VAULT <-->|SafeERC20| USDC[(USDC on Arc)]
    VAULT -.->|pays through| ESC[StableSettleEscrow]

    U[Merchant / Customer / Admin] -->|wagmi: send tx| FE[Vite + React app]
    FE -->|write txs| ESC
    ESC <-->|SafeERC20 transfers| USDC
    ESC -->|events| RPC[Arc Testnet RPC]
    FE -->|"default: viem reads events"| RPC

    subgraph Optional["Optional backend (VITE_API_URL)"]
      IDX[Indexer worker] -->|viem poll events| RPC
      IDX -->|upsert orders + events| DB[(Postgres)]
      API[Hono API] --> DB
    end
    FE -.->|"opt-in: type-safe RPC client"| API
```

The contract is always the source of truth. The frontend works **with no backend at all** — it reconstructs the full audit log directly from contract events via viem. An optional Hono API + indexer + Postgres layer adds server-side aggregation and a queryable event store; the frontend opts in via `VITE_API_URL`.

```
StableSettle/                 bun workspaces
├── packages/contracts/   Foundry — AgentVault + StableSettleEscrow + MockUSDC, tests, deploy scripts
├── packages/shared/      Zod schemas, DTOs, canonical ABIs (incl. AgentVault)
├── apps/mcp/             MCP server — arc:spawn-agent / agent_pay / get_agent (Circle + ENS + World ID)
├── apps/web/             Vite + React + TanStack + wagmi/viem + shadcn/ui frontend
├── apps/api/             Hono + Drizzle + Postgres — type-safe RPC API
├── apps/indexer/         viem worker mirroring events → Postgres + reconciliation
└── docs/                 PRD, build todo, demo + contract + user-flow docs
```

---

## Smart contracts

### `AgentVault` — the budget-capped treasury

Holds USDC for one agent. Three roles: `HUMAN_OWNER_ROLE` (fund, `setCap`, `revoke`/`reinstate`, `withdraw`), `AGENT_ROLE` (`spend`), and `FEE_ADMIN_ROLE` (the protocol — sets the spend fee).

- **The guarantee:** `spend()` reverts with `BudgetExceeded(requested, remaining)` once cumulative spend would cross the cap — enforced in Solidity, not flagged.
- **Per-transaction cap (opt-in):** an optional per-spend ceiling (`setMaxPerSpend`, default off) reverts with `PerSpendLimitExceeded` — an item-level limit so no single purchase exceeds $X, regardless of remaining budget. "The agent can buy, but nothing over $50 at a time."
- **Daily velocity limit (opt-in):** an optional rolling 24h ceiling (`setDailyLimit`, default off) reverts with `DailyLimitExceeded` — so even with budget left under the lifetime cap, a hijacked agent can't drain a year's budget in one minute. Resets automatically once the window elapses.
- **On-chain health, no backend:** `health()` returns `(status, capRemaining, todayRemaining)` — `0` healthy / `1` near-limit / `2` frozen — readable by any dashboard or monitor straight from the contract.
- **Withdraw is locked to one address:** `withdraw(amount)` has no destination parameter — funds can only ever return to `ownerPayout`, an address fixed at construction. So even a fully compromised `HUMAN_OWNER_ROLE` key (or a withdraw triggered by a prompt-injected agent) can move money *home*, never to an attacker. Set it to a cold address distinct from the operating key to neutralise a key leak.
- **Recipient allowlist (opt-in):** when `allowlistEnabled` is on, `spend()` reverts `RecipientNotAllowed(to)` unless the destination is approved — so a prompt-injected agent can be talked into paying an *attacker* and it **still reverts**, even when the amount, budget, and daily limit are all fine. Owner-managed (`setAllowlistEnabled`, `setAllowed`, `setAllowedBatch`); the agent can never edit the list. Default off, so existing behaviour is unchanged until you opt in.
- `setCap` can never drop below what's already spent; `revoke` freezes the agent while leaving funds withdrawable.
- **Protocol fee, off by default:** an optional `feeBps` (capped at `MAX_FEE_BPS` = 1%) takes a *value-conserving* cut of each spend to a protocol treasury — the recipient nets `amount − fee` and the full `amount` counts against the budget. `FEE_ADMIN_ROLE` is self-administered, so the human owner (DEFAULT_ADMIN) can't grant it to themselves and disable it; it can shave the protocol's margin but never rug the agent. See [Business model](#business-model).
- Records the agent's **ENS name** and the human's **World ID nullifier** on-chain (`VaultDeployed`) as provenance for the human-backed claim.
- `SafeERC20` on every transfer, `ReentrancyGuard` + checks-effects-interactions on `spend`/`withdraw`, OpenZeppelin `AccessControl`.
- **56 Foundry tests** cover the over-budget revert, the per-transaction cap, the daily-limit revert + window reset, the `health()` states, underfunded vault, cap changes, revoke/reinstate, the withdraw-only-to-`ownerPayout` lock (including a compromised-owner-key case), the recipient allowlist (not-allowed reverts even under budget; agent can't edit the list), the protocol fee, and access control.

### `StableSettleEscrow` — the settlement engine

- `SafeERC20` for every token move; `ReentrancyGuard` on `fundOrder`, `release`, `resolveDispute`.
- **Value-conservation invariant** on `createOrder` (buckets sum == total) and `resolveDispute` (payouts sum == total) — no minting, no trapped funds.
- `AccessControl` roles: `MERCHANT_ROLE`, `ORACLE_ROLE`, `ADMIN_ROLE` (a multisig in production).

**92 Foundry tests pass across the repo** (`forge test`), including a stateful invariant run.

---

## Quickstart

### Prerequisites
- [Foundry](https://book.getfoundry.sh/) (`foundryup`) · [Bun](https://bun.sh/)
- An Arc-testnet wallet. Arc uses **USDC as gas** — fund it at <https://faucet.circle.com>.

### 1. Contracts

```bash
cd packages/contracts
forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1
forge test         # 82 passing

cast wallet import deployer --interactive     # one-time
export ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network

# Deploy the settlement engine (MockUSDC, or pass USDC_ADDRESS for real Arc USDC):
forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_TESTNET_RPC_URL --account deployer --broadcast

# Deploy a standalone AgentVault for testing (the MCP server deploys these at runtime):
AGENT_ADDRESS=0x… BUDGET_CAP=5000000000 \
  forge script script/DeployAgentVault.s.sol:DeployAgentVault --rpc-url $ARC_TESTNET_RPC_URL --account deployer --broadcast
```

`Deploy.s.sol` writes `apps/web/src/deployments.json` so the frontend picks up the escrow + token addresses automatically.

### 2. MCP server (`arc:spawn-agent`)

```bash
cd apps/mcp
cp .env.example .env        # set ARC_TESTNET_RPC_URL, DEPLOYER_PRIVATE_KEY, USDC_ADDRESS,
                            # Circle CIRCLE_API_KEY + ENTITY_SECRET + CIRCLE_BLOCKCHAIN,
                            # NAMESTONE_API_KEY for ENS, WORLD_ID_APP_ID + WORLD_ID_ACTION for World ID
bun run dev                 # stdio MCP server: spawn_agent / agent_pay / get_agent
```

**Registering the server — no CLI needed.** The repo ships a project-scoped [`.mcp.json`](.mcp.json), so when you open this folder in **Claude Code** it auto-detects the `stablesettle` server and just asks you to approve it — no `claude mcp add`. (Claude Desktop: add the same `command`/`args` once in its config.) The deployer key acts as the human owner and deploys vaults; Circle provides the isolated agent wallet.

> Already ran `claude mcp add stablesettle …` manually and seeing *"already exists"*? That's a duplicate local entry shadowing the project one — remove it with `claude mcp remove stablesettle -s local` and let `.mcp.json` handle it. Either way, **restart Claude Code after pulling new code** — stdio servers are spawned at launch and don't hot-reload.

**Serve it over a URL instead (so others connect without the repo).** The same server speaks Streamable HTTP — set a token and run:

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=8080 MCP_AUTH_TOKEN=$(openssl rand -hex 32) bun --filter='@stablesettle/mcp' run start:http
# health: curl localhost:8080/health → ok
```

Then point any MCP client at it (locally for now; put it behind your domain later):

```bash
claude mcp add --transport http stablesettle http://localhost:8080/mcp --header "Authorization: Bearer <token>"
```

The HTTP process holds the deployer + Circle keys, so `MCP_AUTH_TOKEN` is required before exposing it beyond localhost. Whoever runs this process funds/owns the agents; pass an `owner` to `spawn_agent` to make a connecting user the vault owner instead.

**Works in any MCP client — not just Claude.** It's a standard MCP server, and there are two ways to connect depending on whether you have the code:

**① You have the repo (self-host / dev) — stdio.** The client spawns the local server, so the path points at *your* checkout. Ready-made configs are checked in: [`.mcp.json`](.mcp.json) (Claude Code), [`.cursor/mcp.json`](.cursor/mcp.json), [`.vscode/mcp.json`](.vscode/mcp.json) — open the repo in that tool and it just works. For **Codex** (`~/.codex/config.toml`), the path is to your local clone:

```toml
[mcp_servers.stablesettle]
command = "bun"
args = ["run", "/ABSOLUTE/PATH/TO/StableSettle/apps/mcp/src/index.ts"]
```

**② Connecting to a hosted instance (no repo — the normal user) — HTTP URL.** When someone *else* runs the server (you, behind a domain), users need **no code** — just the URL + token. This is the path that scales to real users.

```bash
# Claude Code
claude mcp add --transport http stablesettle https://mcp.your-domain/mcp --header "Authorization: Bearer <token>"
```
```jsonc
// Cursor — .cursor/mcp.json
{ "mcpServers": { "stablesettle": { "url": "https://mcp.your-domain/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
// VS Code — .vscode/mcp.json
{ "servers": { "stablesettle": { "type": "http", "url": "https://mcp.your-domain/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

Either way the user just asks in plain English — the tool descriptions drive it, no docs needed. (In Claude Code, the `/mcp__stablesettle__quickstart` prompt also generates a live how-to.)

**Try the agentic nanopayment** (`agent_pay_x402`): set `X402_SELLER_ADDRESS` in `.env`, run the demo seller with `bun run --filter='@stablesettle/mcp' x402:seller`, then call `agent_pay_x402` with `url: http://localhost:4021/quote/ETH-USD`. The agent pays the toll via its vault and gets the quote back — and once the budget is spent, the same call reverts. (No live services? `bun run --filter='@stablesettle/mcp' x402:e2e` proves the whole loop offline.)

**World ID setup** (human-backed agents): create an app + incognito action `authorize-agent` at [developer.worldcoin.org](https://developer.worldcoin.org), use the **staging** `app_staging_…` id. Open `apps/mcp/public/verify.html?app_id=…&signal=<your DEPLOYER address>`, scan with the [simulator](https://simulator.worldcoin.org) (no Orb needed), and pass the resulting JSON as `spawn_agent`'s `worldIdProof`. The server verifies it via the cloud endpoint and records the nullifier on-chain.

**ENS one-time setup** (so subnames resolve): get a key at [namestone.com](https://namestone.com/try-namestone), enable your parent domain (e.g. `stablesettle.eth`), and point the parent's ENS resolver at NameStone's offchain resolver (a single on-chain tx — use Sepolia to save ETH, set `NAMESTONE_NETWORK=sepolia`). After that, each spawn issues a subname with the agent's address + spend-policy text records via one gasless API call.

### 3. Frontend

```bash
cd apps/web && bun install && bun run dev    # http://localhost:5173
```

Connect your wallet (it prompts to switch to Arc testnet), then open **Demo mode** to step through the escrow scenarios, or **Agent Vaults** to inspect any vault live — paste its address to watch the budget meter, the daily-velocity meter, the on-chain `health()` badge, and the `Spent` event history, all read straight from the contract.

### 4. Backend (optional)

```bash
bun install
bun run db:up          # Postgres via docker-compose (port 5433)
bun run dev:api        # Hono API → http://localhost:8787
bun run dev:indexer    # mirrors contract events → Postgres
echo 'VITE_API_URL=http://localhost:8787' >> apps/web/.env.local && bun run dev:web
```

Endpoints: `GET /orders`, `GET /orders/:id`, `POST /orders/:id/metadata`, `GET /dashboard`, `GET /reconciliation/:id`, `GET /indexer/status`.

See [`docs/spend-cap.md`](docs/spend-cap.md) for how the spend limit is enforced (the judge explainer), [`docs/demo-script.md`](docs/demo-script.md) for the 3-min walkthrough (or [`docs/demo-90s.md`](docs/demo-90s.md) for the tight agent-first version), [`docs/smart-contracts.md`](docs/smart-contracts.md) for the contract reference, [`docs/user-flow.md`](docs/user-flow.md) for the user-flow diagrams, and [`docs/roadmap.md`](docs/roadmap.md) for what's shipped vs. the production path.

---

## Testing

- **Contracts:** `forge test` — 92 tests (AgentVault cap/daily-limit/health/fee/roles/withdraw-lock/allowlist, escrow scenarios + invariant).
- **On-chain spine, end-to-end:** `bun run --filter='@stablesettle/mcp' e2e:local` — spins anvil and runs the real viem path the MCP server uses (deploy MockUSDC → deploy `AgentVault` via `chain.ts` → fund → set fee → agent spends under cap with fee routed → **over-budget spend reverts** → read state). No external services needed.
- **x402 nanopayment, end-to-end:** `bun run --filter='@stablesettle/mcp' x402:e2e` — spins anvil **and the real x402 seller**, then drives the full HTTP 402 round-trip: buyer pays via `AgentVault.spend` → seller verifies the spend on-chain → returns the data → a second, **over-budget buy is blocked by the cap**. Also offline.
- **Real-run preflight:** `bun run --filter='@stablesettle/mcp' doctor` — validates RPC reachability, deployer gas/USDC balance, and Circle/ENS/World ID config before a live Arc demo.

The Circle / ENS / World ID legs need live API keys + a funded Arc deployer, so they're exercised against their real services (run `doctor` first); the spine above is fully reproducible offline.

## What is simulated (disclosed on purpose)

- **ENS subnames are live via NameStone** (gasless offchain subnames). `arc:spawn-agent` issues `<agent>.stablesettle.eth` with the agent's address + spend-policy/budget text records, resolvable on real ENS clients (viem/ethers, the ENS app). Needs a `NAMESTONE_API_KEY` plus a one-time on-chain setup (point the parent's resolver at NameStone's offchain resolver + enable the domain). Without the key the name is still reserved/returned, just not issued.
- **World ID is cloud-verified.** Arc has no World ID Router, so the IDKit proof is verified off-chain via Worldcoin's cloud endpoint (`verifyCloudProof`) and the resulting **nullifier is recorded on-chain** in the vault. Proofs come from the verify page (`apps/mcp/public/verify.html`) scanned with the World App or the **staging simulator** (no Orb needed). Needs `WORLD_ID_APP_ID` + `WORLD_ID_ACTION`; without them — or without a proof — the agent is recorded as not-yet-verified (zero nullifier), and spawn still works.
- **The delivery & duties oracle is simulated.** "Delivered / refused" and the actual-duties figure come from an admin/oracle action, not a real carrier or customs feed. The contract *enforces* the anomaly rule; the input is mocked.
- **The refund window is shortened** (0–30s) for the demo; production uses 7–14 days.
- StableSettle is **settlement infrastructure** — not tax/legal advice, not a Merchant of Record, and it does not calculate real duties or touch card chargebacks.

## Tech & sponsors

| Sponsor | Used for | Why it matters |
|---|---|---|
| **Arc** | Settlement + vault chain | USDC-native programmable payments; the budget cap is enforced on-chain |
| **Circle** | Agent wallet (USDC/EURC) | Isolated server wallet the agent controls; Arc is Circle's chain |
| **ENS** | Agent identity | Human-readable agent name + spend policy in text records |
| **World ID** | Human authorization | A real human vouches for the agent before its vault goes live |
| **MCP** | Interface | Spawn and control the agent from inside Claude |

Primary submission: *Best Smart Contracts on Arc with Advanced Stablecoin Logic*. Also targets *Best Agentic Economy with Circle Agent Stack* — `agent_pay_x402` is a real agentic nanopayment (the agent autonomously buys an x402 service), with the on-chain budget cap kept in the trust path.

- Solidity + Foundry + OpenZeppelin · Vite + React + TanStack Router/Query + wagmi/viem + Tailwind + shadcn/ui + Framer Motion · `@modelcontextprotocol/sdk` + `@circle-fin/developer-controlled-wallets`.
- Built with [Circle Skills](https://github.com/circlefin/skills) for Arc.

> **Spawn an AI agent with a wallet, identity, and on-chain spending limit in one command.**
