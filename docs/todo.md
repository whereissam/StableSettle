# StableSettle — Build Todo (Two-Week Plan)

Structured for a **~2-week** build: **Week 1 = foundations**, **Week 2 = scenarios & polish**. Day numbers are a guide, not a contract — adjust to your real calendar.

**The rule:** the committed scope (PRD §3 — contract, Hono backend + indexer, TanStack frontend, three scenarios, two currencies, Chainlink oracle, one wallet sponsor) runs end to end before anything under "Stretch" is touched. With two weeks the goal is a mid-sized project done *precisely* — not a big project done halfway.

---

## ⚙️ Build status — updated 2026-06-12

> Note: this todo describes a larger 2-week plan than PRD §3's committed MVP (the PRD says
> *one contract, one app, two scenarios, USDC only, **no backend***). Following the PRD's
> own rule, the **§3 MVP was built end to end first**. What exists today:

**Done (runs end to end — three scenarios, two currencies):**
- `StableSettleEscrow.sol` + `MockUSDC.sol` + `MockEURC.sol` — 6 states, 8 functions, 8 events,
  AccessControl (MERCHANT/ORACLE/ADMIN), SafeERC20, ReentrancyGuard, CEI, value-conservation
  invariants, **duties-anomaly flag** (`reportActualDuties`/`clearAnomaly`, release blocked while
  flagged), **per-order settlement token** (USDC or EURC; constructor default + per-order override).
- **36 Foundry tests** green — Scenario A, B, C, EURC settlement, all revert paths, **4 fuzz tests**,
  and a **solvency invariant** (balance == unreleased funds) over 128k random calls.
- Deploy script — mock-or-real USDC **and** EURC, writes `deployments.json`; `Seed.s.sol` seeds 4 demo orders.
- Frontend (Vite + React + TanStack Router/Query + wagmi/viem + shadcn/ui + Framer Motion):
  Landing, Dashboard (+ anomaly alert), **animated order-detail centerpiece** (anomaly callout),
  **reconciliation card** (duties variance + per-recipient expected/actual/Δ), Demo mode
  (A/B/C + EURC + reset + auto-run), audit log, 6-state timeline, **currency-aware ($/€, USDC/EURC)**.
  **Mobile-responsive.** Typecheck + prod build clean.
- **Backend layer** — bun workspaces: `packages/shared` (Zod + DTOs + ABIs), `apps/api`
  (Hono + Drizzle + Postgres, type-safe RPC client), `apps/indexer` (viem event worker +
  reconciliation). Parallel to the direct-read frontend (opt-in via `VITE_API_URL`).
  docker-compose for Postgres. Verified end to end on local anvil (incl. the EURC order).
- README with architecture + state + scenario-flow diagrams, `docs/demo-script.md`,
  `docs/smart-contracts.md`, `docs/user-flow.md`, **`docs/api.md`** (Hono endpoints).
- **Deployed live on Arc testnet** (chain 5042002, `deployments.json`): escrow
  `0x7B11…af98`, **real Arc USDC** `0x3600…0000`, EURC `0x89B5…D72a` (`usdcIsMock: false`).
- **Frontend verified against the live testnet deploy.** Fixed direct-chain reads that were
  silently broken: `eth_getLogs` now pages in ≤9k-block windows (Arc RPCs hard-cap at 10k),
  scans concurrently, incrementally caches immutable `OrderCreated` history, and pins
  `VITE_DEPLOY_BLOCK=43956374` so it doesn't walk ~44M empty blocks. Theme migrated to
  Tailwind v4 tokens. See [memory: arc-rpc-getlogs-limits].

**Not built yet (the larger plan — awaiting go-ahead):**
- Chainlink Functions oracle · **Dynamic** wallet onboarding · demo video.
- **Host the web app** at a public URL (no Vercel/Netlify config yet) — needed for the
  ETHGlobal "live demo URL" requirement.

---

## Priority order (if the calendar slips, protect the top of this list)

1. `StableSettleEscrow`: create → fund → deliver → release (Scenario A).
2. Dispute branch (Scenario B) + anomaly gating (Scenario C).
3. Real Foundry test suite incl. fuzz + invariant.
4. Hono backend + standing event indexer + DB.
5. TanStack frontend: animated order-detail centerpiece + dashboard.
6. Chainlink Functions delivery oracle.
7. Reconciliation view.
8. Privy/Dynamic onboarding.
9. Docs, architecture diagrams, demo video.

---

# WEEK 1 — FOUNDATIONS

## Day 1 — Lock & skeleton
- [x] Confirm committed scope = PRD §3. Read PRD §4 aloud; agree nothing there starts in Week 1.
- [x] Repo: `apps/web` (TanStack Start), `apps/api` (Hono), `apps/indexer` (worker), `packages/contracts` (Foundry), `packages/shared` (Zod schemas + types). — ✏️ *all five exist (bun workspaces); web uses TanStack **Router**, not Start.*
- [x] Confirm Arc testnet RPC + chain ID + faucet. If flaky, pick the Arc-compatible EVM fallback **now**. — ✏️ *Arc Testnet (chain 5042002) confirmed in viem.*
- [x] Lock the demo order: $100 → $85 / $8 / $5 / $2.
- [ ] **Skeleton spike (critical):** TanStack + wagmi + a Hono RPC endpoint, wired together and **deployed**. — ✏️ *web + Hono RPC wired and verified locally (anvil + Postgres); not yet deployed to a host.*

## Day 2-3 — Contract: happy path + dispute
- [x] Foundry + OpenZeppelin + Chainlink contracts installed. — ✏️ *Foundry + OZ 5.6.1 (Chainlink not in MVP).*
- [x] `MockUSDC.sol` and `MockEURC.sol` — ERC-20s with public `mint()`. — ✏️ *both done (6-decimal).*
- [x] `StableSettleEscrow.sol`: `OrderState` (6), `Split`, `Order` (incl. `estimatedDuties`, `actualDuties`, `anomalyFlagged`, per-order `token`), `mapping(bytes32 => Order)`. — ✏️ *constructor sets a default token (USDC); each order may settle in USDC or EURC.*
- [x] AccessControl: `MERCHANT_ROLE`, `ORACLE_ROLE`, `ADMIN_ROLE`.
- [x] `createOrder()` — token-agnostic (per-order `token`, 0 = default USDC); require 4 buckets sum == totalAmount.
- [x] `fundOrder()` — `SafeERC20.safeTransferFrom` of `order.token`; state → `Funded`.
- [x] `markDelivered()` — ORACLE_ROLE; set `deliveredAt`.
- [x] `release()` — require window elapsed AND `!anomalyFlagged`; pay 4 buckets; state → `Released`. CEI; guard double release.
- [x] `raiseDispute()` / `resolveDispute()` — dispute branch; require payouts sum == totalAmount.
- [x] `ReentrancyGuard` on `fundOrder` / `release` / `resolveDispute`.

## Day 3-4 — Contract: anomaly + full test suite
- [x] `reportActualDuties()` — ORACLE_ROLE; auto-set `anomalyFlagged` if actual > 2× estimate.
- [x] `clearAnomaly()` — ADMIN_ROLE.
- [x] All events emitting the fields the indexer needs. — ✏️ *8 events (added `ActualDutiesReported`, `AnomalyCleared`; `estimatedDuties` added to `OrderCreated`).*
- [x] Foundry tests — unit: every path for A, B, C; bad splits revert; unauthorized roles revert; double release/resolve revert; release-before-window reverts; release-while-flagged reverts. — ✏️ *all done (29 unit + 4 fuzz + 1 invariant = **34 tests green**).*
- [x] Foundry **fuzz** tests on `createOrder` and `resolveDispute` splits. — ✏️ *4 fuzz tests, 256 runs each (valid/invalid split, value conservation).*
- [x] Foundry **invariant** test: contract token balance == sum of unreleased order funds. — ✏️ *handler-driven, 256 runs × 128k calls, 0 failures.*
- [x] Deploy `MockUSDC`, `MockEURC`, `StableSettleEscrow` to testnet. — ✏️ *live on Arc testnet (chain 5042002): escrow `0x7B11…af98`, **real Arc USDC** `0x3600…0000` (not mock), EURC `0x89B5…D72a`. See `deployments.json`.*

## Day 5 — Backend + indexer foundation
- [x] `packages/shared`: Zod schemas (order, split — the "sums to total" check lives here, reused both sides) + shared types + canonical ABIs + DTOs.
- [x] Hono app, RPC mode; type-safe `hc<AppType>` client for the frontend (opt-in via `VITE_API_URL`).
- [x] DB schema (Drizzle + Postgres): merchants, orders, mirrored event log, reconciliation, indexer cursor.
- [x] **Standing indexer worker** (`apps/indexer`): viem polls the 8 contract events, upserts order state + appends events + recomputes reconciliation; resumes from a stored cursor on restart.
- [x] Hono endpoints: `orders` (list/detail/metadata), `dashboard` aggregates, audit log, reconciliation, indexer status.
- ✏️ *Built as a **parallel** layer (frontend still defaults to direct event reads; set `VITE_API_URL` to use the API). **Verified end to end on local anvil + Postgres**: indexer mirrored all 18 seed events, dashboard showed $300 settled across 3 orders, reconciliation correctly flagged the dispute as a mismatch. `docker compose up -d postgres` + `bun run dev:api` + `bun run dev:indexer`.*

> **End of Week 1 target:** contract deployed with three scenarios passing tests (incl. fuzz/invariant); Hono + indexer mirroring events into the DB; TanStack+wagmi+Hono skeleton deployed. If you are not here, drop ALL stretch goals and compress Week 2 polish.

---

# WEEK 2 — SCENARIOS & POLISH

## Day 6-7 — Frontend core + Scenario A end to end
- [x] Router routes, layout/nav, Tailwind + shadcn/ui. — ✏️ *TanStack **Router** (not Start), shadcn via CLI.*
- [x] TanStack Query: wrap contract reads (wagmi); one shared QueryClient. — ✏️ *wagmi/viem reads only; no Hono RPC.*
- [x] Order detail page — actions wired: fund, mark delivered, release.
- [x] Mock USDC mint + approve buttons for the demo. — ✏️ *USDC only (mint shown when MockUSDC is the token).*
- [x] Scenario A runs fully through the UI.

## Day 7-8 — Scenarios B & C + EURC
- [x] Scenario B (dispute) wired end to end through the UI.
- [x] Scenario C (anomaly): `reportActualDuties` → auto-flag → `release()` blocked → admin `clearAnomaly`. — ✏️ *wired in Demo mode (3rd order) + actions panel + auto-run.*
- [x] Run one scenario as a **EURC-denominated** order; confirm token-agnostic path works for both currencies. — ✏️ *per-order settlement token: `createOrder(token)` (0 = default USDC); 4th demo order settles in EURC; currency-aware UI ($/€ + USDC/EURC badges). Verified on-chain: escrow moved EURC not USDC, settled clean. 2 EURC contract tests.*
- [x] Demo mode page: one-click steps + reset. — ✏️ *Scenarios A/B/C + Auto-run + reset; 3 demo orders, `refundWindowSeconds = 0`.*

## Day 8-9 — The centerpiece + dashboard + reconciliation
- [x] **Animated order-detail centerpiece** (PRD §9): split animates into buckets; reserve locked; `release()` flows funds out; dispute freezes red; **anomaly variance callout + blocked-release banner**; resolve splits along resolved amounts.
- [x] 6-state status timeline + audit log, each row linking to the on-chain tx. — ✏️ *audit log from contract events directly (or the indexer's mirrored log when `VITE_API_URL` is set).*
- [x] Dashboard cards: volume settled, pending, reserves locked, disputed; recent events; **anomaly alert banner**.
- [x] **Reconciliation view:** per order, estimated vs actual duties, expected vs actual payouts, tx hashes, mismatches flagged. — ✏️ *`ReconciliationCard` on the order-detail page — duties variance + per-recipient expected/actual/Δ with mismatch highlighting; computed client-side from order + events (works with or without the backend). Backend also serves `GET /reconciliation/:id`.*

## Day 9-10 — Chainlink oracle + wallet onboarding
- [ ] Chainlink Functions consumer contract; wire `ORACLE_ROLE` to it.
- [ ] Mock carrier API endpoint (delivery status / actual duties) for Functions to call.
- [ ] Replace the admin "delivered" trigger with the real Functions call; keep the admin button as a dev fallback.
- [ ] Pick **one** wallet sponsor (Privy or Dynamic — never both); email/embedded-wallet login; merchant profile on first login.

## Day 11-12 — Polish
- [x] Fintech-SaaS look: clean cards, status colors, no DeFi/yield visuals, minimal jargon.
- [x] Loading / empty / error states on every action; responsive layout.
- [x] Label every simulated element as simulated in the UI.
- [x] Tighten the centerpiece animation — this is the screen judges remember.

## Day 13 — Docs & diagrams
- [x] README: problem, solution, contract addresses, setup, explicit "what is simulated" note. — ✏️ *screenshots + demo-video link still TODO.*
- [x] Diagrams: architecture (PRD §7), contract state diagram, scenario-flow diagram. — ✏️ *Mermaid in README (architecture incl. optional backend, 6-state + anomaly-on-Delivered, 3-scenario flow) + `docs/user-flow.md`.*
- [x] `docs/demo-script.md`, `docs/smart-contracts.md`, `docs/api.md`. — ✏️ *all done (`demo-script.md`, `smart-contracts.md`, `user-flow.md`, and `api.md` documenting the Hono endpoints + DTO shapes).*

## Day 14 — Demo video, rehearsal, submission (+ buffer)
- [ ] Record a clean ≤3-min walkthrough: real `fundOrder` tx, dashboard updating, audit log.
- [ ] Rehearse the 3-min script twice; practice the disclaimers (PRD §12) before a judge asks.
- [ ] ETHGlobal submission: **primary = Arc, Advanced Stablecoin Logic.** Include contract addresses, live demo URL, GitHub, description, "what is simulated" note.
- [ ] Keep this day as buffer — something always slips.

---

## Stretch — only after committed scope runs end to end

1. **In-order USDC↔EURC conversion (LI.FI or 1inch — one):** customer pays EURC, merchant settles USDC, swap at `release()`. Unlocks Arc's *Chain Abstracted USDC* bounty. If real integration is slow, build a clearly-labeled simulated route.
2. **Cross-chain funding:** pay from Base, settle on Arc.
3. Creator dashboard, supplier payout, Shopify CSV import, accounting export, AI reconciliation copilot, risk scoring.

---

## Cut list — deliberately NOT in committed scope

So nobody re-adds them by accident:

- In-order currency conversion / any swap → stretch #1.
- Cross-chain funding → stretch #2.
- AI copilot, Shopify plugin, supplier payouts, accounting export → stretch #3.
- More than 3 sponsors → committed = Arc + Chainlink + one wallet; LI.FI/1inch is stretch only.
- More than 6 order states → 6 states + one `anomalyFlagged` bool.
- Multiple settlement templates → one fixed $100 split.

---

# AGENT VAULT — the firewall pivot (added 2026-06-13)

Since the escrow MVP shipped, the project's hero became **`AgentVault`** — the on-chain spending
firewall for AI agents. **Thesis: bound the *outcome*, don't trust the *intent* ("controlled
autonomy" — 把無限自主權壓縮成受控自主權).**

**Built this session (runs end to end, live on Arc):**
- `AgentVault.sol` — lifetime cap + per-tx cap + 24h velocity limit + **withdraw locked to a fixed
  cold `ownerPayout`** + **opt-in recipient allowlist** + on-chain `health()` + capped non-bricking
  fee + ENS/World ID provenance. **56 AgentVault tests / 92 repo-wide.**
- Owner resolved from **server config, never a tool argument** (no prompt-injection takeover).
- MCP tools: `spawn_agent` (cap/maxPerSpend/dailyLimit/allowlist/fund/gas) · `fund_agent` ·
  `topup_gas` · `agent_pay` · `agent_pay_x402` · `get_agent` · `sync_allowlist_from_ens`
  (Tier-2: ENS policy → on-chain allowlist). Offline e2e 15/15.

## Security review fixes (2026-11-03)
Focused review of `AgentVault.sol` + `StableSettleEscrow.sol` found 3 confirmed issues (PoC tests):
- [x] **Owner key could drain the vault** — `human` holds `DEFAULT_ADMIN_ROLE`, so a stolen owner key
  could `grantRole(AGENT_ROLE, attacker)`, lift the limits and `spend` everything to itself, breaking
  the "funds only ever go home to `ownerPayout`" invariant. Fix: the agent is fixed at construction —
  `grantRole(AGENT_ROLE, …)` always reverts. — ✅ 2026-11-03 `fix/contract-security-review`:
  `AgentVault.grantRole` override + `AgentImmutable` error; tests `test_ownerCannotGrantAgentRole`.
- [x] **Daily limit was a fixed window, not rolling** — the agent could spend ~2× `dailyLimit` within
  seconds across a window boundary. Fix: hourly-bucket rolling window (any 24h ≤ limit). — ✅ 2026-11-03
  `fix/contract-security-review`: 25-slot hour ring buffer; `windowStart`/`spentToday` replaced by `spentLast24h()` (ABI
  change; no TS callers). A spend frees up 24–25h later. Regression + fuzz tests added.
- [x] **Customer could dispute after the refund window closed** — freezing a payout already due.
  Fix: `raiseDispute` by the customer reverts once `deliveredAt + refundWindowSeconds` has passed. — ✅
  2026-11-03 `fix/contract-security-review`: `DisputeWindowClosed` error; oracle can still escalate late. Demo Scenario B
  unaffected (disputes from `Funded` / via the oracle wallet). **114/114 Foundry tests pass.**
- [ ] Redeploy: contracts are immutable — the live Arc escrow and already-spawned vaults keep the old code.
- [ ] TS typecheck after the ABI regen (`bun install` then `bun run typecheck`) — skipped, deps not installed.
- [ ] Consider a gas check: `spend` with a daily limit now reads 25 storage slots (~50k gas extra).

## Now — highest-ROI before submission (presentation, NOT more contract layers)
- [ ] **Pitch slide 1 rewrite** around *controlled autonomy* + the AI-vs-human asymmetry
  (machine speed, no chargeback, prompt-injection amplification → why AI needs *harder* limits).
- [ ] **Polish + record the demo.** Money shot = prompt-inject the agent to pay an attacker →
  `RecipientNotAllowed` reverts even though amount/budget/daily are all fine.
- [ ] **Tighten README/deck** on "bound the outcome, don't trust the intent."
- [ ] Host the web dashboard at a public URL (carried over — only if keeping the read-only dashboard).

## Future backlog — recorded, NOT hackathon scope
Honest verdicts so these are captured without becoming a reason not to ship.

**Worth doing later (on-thesis, contained):**
- [ ] **Spend audit memo** — optional `memo`/`reasonHash` on `spend`, emitted in the event. Frame as
  a *human audit trail* (what the agent claimed it bought), **not** proof of honest intent — a
  compromised agent fakes the memo too. ~30 min; useful for the dashboard "I paid, but where/why" story.
- [x] **ENS-profile-sourced allowlist (Tier 2 — ENS as policy source)** — ✅ **BUILT.** Owner publishes
  approved recipients in an ENS text record (`stablesettle-allowlist`); `sync_allowlist_from_ens` reads
  them back via a standard CCIP-Read ENS client and writes them into the on-chain AgentVault allowlist,
  which the contract enforces. ENS is now **load-bearing** (pull it out → the firewall has no policy
  source), not decorative. Policy ENS name = SERVER config (`ENS_POLICY_NAME`), never a tool arg, so a
  prompt-injected model can't point it at an attacker-controlled name. Web **Agent Vaults** page also
  resolves the agent's ENS name live + shows the spend-policy text records (write→read round-trip).
  Files: `apps/mcp/src/ens-read.ts`, `sync_allowlist_from_ens` in `index.ts`; `apps/web/src/lib/ens.ts`
  + `useAgentEns`. This is the ENS-track answer: ENS = the agent's portable identity + policy layer
  (ties to ENSIP-26 Agent Text Records), not just `name.eth` resolution.
- **Granular sub-budgets (per-recipient / per-category caps)** — the differentiator over a flat
  Safe Guard / Session Key limit: our `spend()` already sees `to`, so the contract can enforce
  *who gets how much*, not just *how much total*. Three tiers, easy → hard:
  - [x] **Per-recipient cap** — ✅ **BUILT (2026-06-15).** "vendor 0xABC ≤ $100", enforced on-chain.
    Implemented as **parallel `recipientCap`/`recipientSpent` mappings** (not a struct rewrite of the
    `bool` allowlist) so the existing `allowedRecipients` getter/ABI and all prior tests stay green —
    fully backward compatible. New: `setRecipientCap` + `setAllowedWithCap` (approve + cap in one tx),
    `recipientRemaining` view, `RecipientCapExceeded` error, `RecipientCapChanged` event. Spend records
    per-recipient only while a cap is set (matches `maxPerSpend`/`dailyLimit` "future-spends-only"
    semantics). **+14 Foundry tests (70 AgentVault / 106 repo-wide), +4 local-e2e checks (19/19).**
    Wired through MCP: `set_recipient_cap` tool + `readRecipientCap` + named revert in `simulateSpend`.
  - **Per-category budget** — owner tags each allowlisted recipient with a `categoryId`; each category
    gets its own sub-budget under the lifetime cap. More state, same revert model.
  - ⚠️ **True merchant-category (Visa-MCC style) is NOT on-chain-inferable** — the chain can't know what
    a `0x…` address *sells*. "Category" = an owner-assigned (or ENS-text-record-sourced) mapping, not
    something the contract derives. Be honest about this in the pitch; don't claim auto-classification.
  - **Demo stance: roadmap + Q&A answer, do NOT build before submission.** The shipped four limits
    (lifetime + per-tx + daily + allowlist) already prove the thesis; granularity is config on the same
    enforcement. Half-built granularity risks a live-demo bug for no narrative gain.
- [x] **Per-user owner binding (non-custodial)** — ✅ **BUILT.** Owner/payout = the connecting user's
  OWN address (not the operator). See the "Multi-user → prod" section below. (We landed on
  *non-custodial* — owner = the user's own wallet — which is stronger than the earlier "custodial"
  idea: the operator is never the owner, so it can't withdraw, raise the cap, or redirect funds.)
- [ ] **Pre-spend compliance screening** (production) — sanctioned-address / AML check via Circle or
  Chainlink before a spend. Off-chain layer → keep it an *optional* gate; the on-chain allowlist stays
  the trustless path.

**Explicitly NOT building (anti-scope-creep — these are traps):**
- ❌ **Verifiable reasoning / intent ZK-proof** — category error vs the thesis. A self-generated
  reasoning hash proves nothing; we bound outcomes, not intent. Don't dilute the core claim.
- ❌ **AI BNPL / credit lines** — AI has no repayment incentive → optimizes for max leverage + default.
  Pre-funded + micropayments (x402) is the right model. Only revisit as collateralized / reputation-backed,
  as an opt-in advanced feature — never the main line.
- ❌ **Oracle-driven blocklist / reputation system** — off-chain trust; contradicts "no off-chain gate."
  The opt-in allowlist is the on-chain answer.
- ❌ **Liquidity / solvency guardrails** — N/A for a pre-funded vault; the cap already bounds it.

---

## Multi-user → prod: you rebuild NOTHING (added 2026-06-13)

The engine is done and production-grade. Going multi-user is a **thin wrapper on top, not a rebuild** —
proven by the fact that the per-user owner binding below **slotted in without touching the contract and
without breaking the demo** (typecheck + `e2e:local` still green).

**✅ Already built — carries straight to prod:**
- `AgentVault` firewall (92 tests), the MCP tools, the Circle agent wallet, the escrow engine.
- **Per-user owner binding (non-custodial):**
  - `apps/mcp/src/users.ts` — token → owner-address registry (tokens stored **hashed**).
  - `http.ts` — per-user auth: a request's bearer token resolves to a `ServerContext`; the session's
    server is bound to it. Shared admin token + stdio paths unchanged → **demo-safe**.
  - `index.ts` — owner resolution: **session user's address → `OWNER_ADDRESS` → deployer.**
    `ownerPayout` = the user's own address, so a malicious operator can't redirect a withdrawal.
    Per-user spawns can't spend the operator's treasury (`fund` is admin-only).
  - Provision: `bun run --filter='@stablesettle/mcp' register-user <token> <userId> <ownerAddress>`.
  - **Result:** the operator is **never the owner** — it only holds the agent's bounded spend wallet.
    Even a fully compromised operator can't drain a user. (The judge-proof trust answer.)

**Left for prod — additive, a wrapper (NOT a rebuild):**
- [ ] **Signup surface** — a small web page / API that issues a per-user token + registers their owner
  address. (The `register-user` CLI is the manual version of this.)
- [ ] **User wallet widget** — a one-time Dynamic or Circle *embedded* wallet (passkey, **Arc supported ✓**)
  so the user gets an owner address with no seed. The address plugs into `register-user`; nothing else changes.
- [ ] **Ops** — back up the Circle entity-secret recovery file (`~/.circle/`) to a vault/KMS; host the
  server (tunnel → domain); add rate limits. Config, not code.

> None of the "left for prod" items touch the contract, the firewall, the MCP tools, or the agent wallet.
> They wrap an engine that already works. **Agent signer stays Circle** (swapping to Dynamic gains nothing
> and risks the build); Dynamic's value is the *user's owner wallet*, which plugs into the binding above.