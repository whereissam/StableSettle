# Usage — how to run StableSettle

This repo has **two halves**. You can run either on its own; you don't need both.

| Half | What it is | Where | Needs |
|---|---|---|---|
| 🥇 **AI treasury** | `arc:spawn-agent` MCP server (`spawn_agent` / `agent_pay` / `get_agent`) | `apps/mcp` | Arc RPC + deployer key + USDC; optional Circle / ENS / World ID keys |
| ⚖️ **Escrow demo** | The settlement web app (the 3 scenarios you click through) | `apps/web` | Deployed contracts (auto-wired) — **no backend** |

**Two questions everyone asks:**
- **Do I need to run the backend (`apps/api` + `apps/indexer` + Postgres)?** → **No.** The web app reconstructs all state directly from chain events via viem. The backend is optional and only adds a queryable event store. Skip it.
- **Do I set the contract address manually?** → **No.** The deploy script writes `apps/web/src/deployments.json` and the app reads it. You only set `VITE_ESCROW_ADDRESS` / `VITE_USDC_ADDRESS` if you want to *repoint* without redeploying.

---

## 0. Prerequisites

```bash
# Foundry (contracts) + Bun (apps)
curl -L https://foundry.paradigm.xyz | bash && foundryup
curl -fsSL https://bun.sh/install | bash

bun install                          # from repo root — installs all workspaces
cd packages/contracts
forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1
```

---

## 1. Fastest check — no keys, no chain, no money

Prove the whole on-chain spine works locally:

```bash
forge test                           # 76 tests (run in packages/contracts)
bun run --filter='@stablesettle/mcp' e2e:local     # spins anvil: deploy → fund → fee → over-budget REVERT, 12/12
```

If those pass, the contracts + the MCP's viem path are sound. Great for development and CI.

---

## 2. Run the escrow web demo (the clickable 3 scenarios)

This is the visual demo. It needs contracts deployed once — **no backend, no manual addresses.**

### 2a. Deploy contracts (once)

For a **self-contained demo, use MockUSDC** (public mint, so the demo can fund itself — recommended):

```bash
cd packages/contracts
cast wallet import deployer --interactive          # one-time: import your key
export ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_TESTNET_RPC_URL --account deployer --broadcast
```

This writes `apps/web/src/deployments.json` (escrow + token addresses + `usdcIsMock`). The app picks it up automatically — **you do not edit any address.**

> To settle in **real Arc USDC** instead, add `USDC_ADDRESS=0x3600000000000000000000000000000000000000`. But then the demo can't `mint` — your connected wallet must already hold USDC from <https://faucet.circle.com>. **For a smooth demo, prefer MockUSDC.**

You deploy **once**. The escrow address only changes if you redeploy — it does not change per run.

### 2b. Run the app

```bash
cd apps/web
bun run dev                          # http://localhost:5173
```

Connect your wallet (it prompts to switch to Arc testnet), open **Demo mode**, and step through / Auto-run the scenarios.

### 2c. (Optional) the backend

Only if you want server-side aggregation + a queryable event store:

```bash
bun run db:up                        # Postgres via docker-compose
bun run dev:api                      # Hono API → http://localhost:8787
bun run dev:indexer                  # mirrors escrow events → Postgres
echo 'VITE_API_URL=http://localhost:8787' >> apps/web/.env.local && bun run dev:web
```

Leave it off unless you specifically need it.

---

## 3. Run the AI treasury (`arc:spawn-agent` MCP server)

### 3a. Configure `.env`

```bash
cd apps/mcp
cp .env.example .env
```

You only fill **three secrets** — the rest is pre-filled (RPC, USDC `0x3600…0000`, chain id, `CIRCLE_BLOCKCHAIN=ARC-TESTNET`). ENS + World ID are **optional**; leave them blank and `spawn_agent` still works (the agent is recorded as name-reserved / not-yet-verified).

**1 · `CIRCLE_API_KEY`** — at [console.circle.com](https://console.circle.com) → **Keys → Create a key**:
- Key type **API Key** (not *Kit* or *Client*), Access **Standard**, on **Testnet**.
- The full `TEST_API_KEY:…:…` string is shown **once** at creation — copy it then and paste into `CIRCLE_API_KEY`. (Closed the dialog? It can't be retrieved — just create another key.)

**2 · `ENTITY_SECRET`** — generate + register it in one command (run *after* the API key is set):

```bash
bun run register-secret
```

Generates a 32-byte secret, registers its ciphertext with Circle, writes a recovery file to `~/.circle/` (**keep it safe, never commit**), and writes `ENTITY_SECRET` straight into your `.env` (the value is never printed). Run once per API key.

**3 · `DEPLOYER_PRIVATE_KEY`** — the wallet that deploys vaults and acts as the **human owner**. Use the **same key** as the deployer in `deployments.json` (and your ENS parent owner, if you set one up). Export it from your wallet → paste it (keep the leading `0x`). Then **fund that address with USDC** at <https://faucet.circle.com> — on Arc, **USDC is the gas token**, so an unfunded deployer can't deploy.

### 3b. Preflight

```bash
bun run --filter='@stablesettle/mcp' doctor        # checks RPC, deployer balance, and which integrations are configured
```

Fix any ✗ before going live.

### 3c. Register with Claude (or any MCP client)

**Easiest — Claude Code:** the repo ships a project-scoped `.mcp.json`, so just open this folder in Claude Code and **approve the `stablesettle` server when prompted**. No CLI.

If you prefer the CLI (or use another client), add a stdio server — the path is relative to the project root:

```bash
claude mcp add stablesettle -- bun run apps/mcp/src/index.ts
# seeing "already exists"? remove the dup first: claude mcp remove stablesettle -s local
```

The server loads `apps/mcp/.env` itself (relative to its own file), so the Circle / RPC config is picked up no matter the launch cwd. **Restart Claude after pulling new code** (stdio servers spawn at launch and don't hot-reload), then in chat:

```
spawn_agent  name="trader-bot" budget=5000 fund=5000 gas=1
agent_pay    name="trader-bot" to="0x…" amount=1200
agent_pay    name="trader-bot" to="0x…" amount=4001   ← reverts: BudgetExceeded
get_agent    name="trader-bot"
```

The vault is deployed at runtime by `spawn_agent` — you never paste a vault address. `get_agent`/`agent_pay` look it up by name (stored in `apps/mcp/.agents.json`).

### 3d. World ID (optional, for human-backed agents)

Create an app + incognito action `authorize-agent` at <https://developer.worldcoin.org> (use the **staging** `app_staging_…` id). Open `apps/mcp/public/verify.html?app_id=…&signal=<your DEPLOYER address>`, scan with the [simulator](https://simulator.worldcoin.org) (no Orb needed), and pass the resulting JSON as `spawn_agent`'s `worldIdProof`.

---

## Troubleshooting

- **`Address "" is invalid` in the web app** → a blank `VITE_ESCROW_ADDRESS=` / `VITE_USDC_ADDRESS=` in `apps/web/.env`. Leave them unset (or remove the lines) so the app falls back to `deployments.json`.
- **Auto-run fails with failed `mint` txns** → you're on **real Arc USDC**, which has no public `mint`. Either deploy with MockUSDC (§2a) or fund the wallet from faucet.circle.com.
- **`doctor` says deployer has no gas** → on Arc, **USDC is the gas token**. Fund the deployer at <https://faucet.circle.com>.
- **MCP tool errors "Invalid recipient/USDC address"** → the address failed validation (this is intentional — see the security notes); pass a valid `0x…` 20-byte address.
