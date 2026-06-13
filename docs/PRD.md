# StableSettle — Product Spec (Two-Week Build)

**Tagline:** Settlement of Record for cross-border commerce
**Version:** v0.2 — ETHGlobal New York, two-week build
**Primary bounty:** Arc — Best Smart Contracts on Arc with Advanced Stablecoin Logic
**Build window:** ~2 weeks. Week 1 = foundations, Week 2 = scenarios & polish (see todo).

This is a build document. With two weeks the constraint is no longer "will it finish" — it is **completeness and polish**. The winning move is not more features; it is a mid-sized project done precisely: three solid scenarios, a backend that makes reconciliation real, a contract with serious tests, and one frontend people remember. Anything under "Out of scope / stretch" still does not get started until the committed scope runs end to end.

---

## 1. The thesis

Cross-border ecommerce payments do not end at checkout. After a customer pays, the merchant still has to handle import duties, rejected packages, refund windows, creator commissions, platform fees, and reconciliation. Crypto payment demos almost all stop at "customer paid USDC, merchant received USDC" — they solve the easy half.

StableSettle turns each order into a programmable settlement contract on Arc. Instead of 100% of the payment going straight to the merchant, the order is split into buckets and released based on what actually happens to the package.

> Stablecoins are not just a cheaper checkout. They are programmable settlement.

The demo highlight is not the moment of payment. It is watching an order's money get split, locked, and conditionally released, frozen, or flagged — verifiably, on-chain.

---

## 2. The problem (sourced from cross-border ecommerce sellers)

After the customer has already paid, merchants repeatedly hit:

- **Surprise duties.** Customer is charged import tax on delivery, didn't expect it, refuses the package.
- **Rejected packages.** Merchant eats original shipping, return shipping, and brokerage — and doesn't know whether to refund fully, partially, or wait.
- **Multi-party splits.** A single order owes a merchant, a platform, and often a creator/affiliate. Today this is manual or relies on Stripe Connect — which stablecoin-native merchants don't have.
- **Billing / duties errors.** Carrier and platform duties charges can be wrong by an order of magnitude (a mistyped commercial invoice turning a $56 item into a $5,633 declared value). Merchants get billed before anyone catches it.
- **Reconciliation.** Order amount, fees, refunds, commissions, and wallet transactions don't line up. Raw crypto payments make this worse, not better.

The common structure: after collection, money needs to be split, conditionally held, and audited — exactly what a smart contract plus a clean indexer are good at.

---

## 3. What we are building (committed scope — two weeks)

A smart contract, a lightweight backend with a live event indexer, and a web app that demonstrates a cross-border order moving through **three** scenarios, in **two currencies**.

### Committed scope

- **Three demo scenarios:** normal delivery, rejected package / dispute, duties anomaly (see §5).
- **Multi-currency:** an order can be denominated in mock USDC **or** mock EURC. The contract is token-agnostic. Demo runs at least one of each. (In-order USDC↔EURC *conversion* is stretch — see §4.)
- **Smart contract on Arc** testnet (Arc-compatible EVM testnet as fallback).
- **Lightweight backend (Hono):** stores off-chain order metadata, runs a standing event indexer, exposes a type-safe RPC API, and powers a reconciliation view.
- **Delivery oracle via Chainlink Functions** calling a mock carrier API — this is a committed third integration, not a mock button (the mock admin button remains as a dev/fallback path).
- **Frontend (TanStack Start):** dashboard, the animated order-lifecycle centerpiece, reconciliation view, demo mode.

### Three committed sponsors (each load-bearing)

- **Arc** — the settlement contract; primary submission.
- **Privy or Dynamic (one)** — email/embedded-wallet onboarding; makes it feel like fintech, not DeFi.
- **Chainlink** — Functions as the real delivery oracle.

---

## 4. Out of scope / stretch (do not start until §3 runs end to end)

Priority order if you finish early:

1. **In-order currency conversion (LI.FI or 1inch — one)** — customer pays EURC, merchant settles USDC, swap at release. This also unlocks Arc's *Chain Abstracted USDC* secondary bounty.
2. **Cross-chain funding** — customer pays from Base, settles on Arc.
3. Creator dashboard, supplier payout module, Shopify CSV import, accounting export, AI reconciliation copilot, merchant risk scoring.

**Non-goals**, regardless of time: StableSettle does not give legal/tax advice, is not a Merchant of Record, does not calculate real duties for every country, and does not touch real card chargebacks. State this in the demo.

---

## 5. The three demo scenarios

Default order — a **$100** order, US customer, Germany merchant:

| Bucket | Amount |
|---|---|
| Merchant | $85 |
| Refund reserve | $8 |
| Creator commission | $5 |
| Platform fee | $2 |

The refund reserve is framed as covering duties/refusal risk — that is the cross-border story. At least one scenario is run as a EURC-denominated order to show multi-currency.

### Scenario A — Normal delivery
Customer funds the order → contract splits into 4 buckets → Chainlink oracle reports `Delivered` → refund window elapses → `release()` pays out all 4 buckets → state `Released`. Dashboard shows a finalized, itemized settlement record.

### Scenario B — Rejected package / dispute
Customer funds → contract splits → `raiseDispute()` (package refused) → buckets freeze, state `Disputed` → admin calls `resolveDispute()` with a split (e.g. $70 refund, $25 merchant, $5 platform) → contract pays exactly that → state `Resolved`. Resolution must satisfy value conservation.

### Scenario C — Duties anomaly
Order created with `estimatedDuties = $8` → oracle reports `actualDuties = $80` → contract auto-sets `anomalyFlagged` (actual > 2× estimate) → `release()` is **blocked** → dashboard shows the variance and a review prompt → admin reviews and either `clearAnomaly()` (then normal release) or routes it into a dispute. This is the scenario that shows StableSettle catching a billing error *before* money moves.

---

## 6. Smart contract spec — `StableSettleEscrow`

Small enough that a judge can read it; serious enough to deserve a real test suite.

### Order states (6) + one flag
`Created → Funded → Delivered → Released`, with `Disputed → Resolved` as the dispute branch (reachable from `Funded` or `Delivered`).
Plus a `bool anomalyFlagged` on the order — it gates `release()` without adding a state.

### Structs
```solidity
struct Split {
    address merchant;
    address creator;
    address platform;
    address customer;
    uint256 merchantAmount;
    uint256 refundReserve;
    uint256 creatorCommission;
    uint256 platformFee;
}

struct Order {
    address token;                // mock USDC or mock EURC — order is denominated in one
    uint256 totalAmount;
    uint256 estimatedDuties;
    uint256 actualDuties;         // 0 until reported
    uint256 deliveredAt;          // 0 until Delivered
    uint256 refundWindowSeconds;  // demo: short; prod: 7-14 days
    OrderState state;
    bool anomalyFlagged;
    Split split;
}
```

### Functions
```solidity
function createOrder(bytes32 orderId, address token, uint256 totalAmount,
                     uint256 estimatedDuties, uint256 refundWindowSeconds,
                     Split calldata split) external;            // MERCHANT_ROLE
function fundOrder(bytes32 orderId) external;                   // customer; pulls `token`
function markDelivered(bytes32 orderId) external;               // ORACLE_ROLE (Chainlink)
function reportActualDuties(bytes32 orderId, uint256 actual) external; // ORACLE_ROLE; auto-flags anomaly
function clearAnomaly(bytes32 orderId) external;                // ADMIN_ROLE
function release(bytes32 orderId) external;                     // anyone, after window, if !anomalyFlagged
function raiseDispute(bytes32 orderId) external;                // ORACLE_ROLE or customer
function resolveDispute(bytes32 orderId, uint256 toCustomer, uint256 toMerchant,
                        uint256 toCreator, uint256 toPlatform) external; // ADMIN_ROLE
```

Invariants:
- `createOrder`: the 4 bucket amounts must sum **exactly** to `totalAmount`.
- `resolveDispute`: the 4 payout amounts must sum **exactly** to `totalAmount` — no minting, no trapped funds.
- `reportActualDuties`: if `actual > estimatedDuties * 2`, set `anomalyFlagged = true`.

### Events
`OrderCreated, OrderFunded, Delivered, ActualDutiesReported, AnomalyFlagged, AnomalyCleared, Released, DisputeRaised, DisputeResolved`.
The backend indexer consumes these; the dashboard audit log is built from them.

### Roles (OpenZeppelin AccessControl)
`MERCHANT_ROLE`, `ORACLE_ROLE` (held by the Chainlink Functions consumer), `ADMIN_ROLE`.

### Security requirements
- `SafeERC20` for all token moves.
- `ReentrancyGuard` on `fundOrder`, `release`, `resolveDispute`.
- Checks-effects-interactions: set state before transferring out.
- Guard double `release()` / double `resolveDispute()`.
- Value-conservation invariants above.
- AccessControl admin → multisig in prod; note in README.
- **Two weeks means a real test suite is expected:** unit tests for every path, plus Foundry fuzz tests on `createOrder`/`resolveDispute` splits and an invariant test that contract token balance always equals the sum of unreleased order funds.

### A real constraint
On a live testnet you cannot fast-forward `block.timestamp`. Set `refundWindowSeconds` short (0–60s) on demo orders so `release()` is callable live; state in the pitch that production uses 7–14 days.

---

## 7. Architecture (three layers)

```
TanStack Start app  (frontend: dashboard, order view, demo mode)
        |  TanStack Query  +  Hono RPC client (type-safe)  +  wagmi/viem
        v
Hono API  +  standing event indexer worker  ──  DB (SQLite/Postgres)
        |  viem: read events / contract state
        v
StableSettleEscrow  +  MockUSDC  +  MockEURC      on Arc testnet
        ^
        |  Chainlink Functions  ──  mock carrier API (delivery status)
```

The contract is the source of truth for funds. The Hono indexer mirrors contract events into the DB so the dashboard and reconciliation view are fast and queryable. wagmi (which itself uses TanStack Query) and the Hono RPC client share one QueryClient — plan query keys so they don't collide.

---

## 8. Backend & indexer (Hono)

- **Hono app**, TypeScript-first, RPC mode → the frontend gets an end-to-end type-safe client.
- **Zod schemas** shared front-and-back; the "split sums to total" check is one schema reused on both sides.
- **Standing indexer worker** — a long-running process (separate from request handlers) that subscribes to contract events and writes them to the DB. This is why the indexer is its own worker, not a server function: it must run continuously for the dashboard to feel live.
- **Stores:** merchant profile, order off-chain metadata (product name, customer country, carrier ref), the mirrored event log, and the reconciliation records.
- **Reconciliation view data:** per order, line up estimated vs actual duties, expected vs actual payouts, and on-chain tx hashes — flag mismatches. This view is what makes the "reconciliation" problem from §2 visibly solved.
- **Endpoints (illustrative):** `orders` (list/detail/create-metadata), `dashboard` (aggregates), `reconciliation`, `audit-log`. Money operations stay on-chain; the backend never custodies funds.

---

## 9. Frontend (TanStack Start)

Tone: **fintech SaaS, not DeFi.** Reference Stripe Dashboard / Airwallex. Clean tables, clear status colors, audit-friendly. No yield-farm visuals, minimal chain jargon.

- **TanStack Start** as the framework; **TanStack Router** for type-safe routing; **TanStack Query** for all data (contract reads via wagmi, backend reads via Hono RPC).
- First-week task: get **TanStack Start + wagmi + Hono RPC** running and deployed as a thin skeleton before building features — Start's SSR/deploy edges are newer than Next.js, surface them early.

### Pages
1. **Landing** — problem, solution, "Launch demo".
2. **Dashboard** — volume settled, funds pending, reserves locked, disputed, anomaly alerts; recent events.
3. **Order detail** — the centerpiece (below).
4. **Reconciliation** — the table from §8: estimated vs actual, expected vs actual, mismatches flagged.
5. **Demo mode** — step buttons for Scenarios A/B/C, plus reset.

### The order-detail centerpiece — the animated settlement view
This wins the demo, so it gets the most polish. The $100 visibly **splits** into four buckets on funding; the refund reserve renders **locked**; on `release()` funds visibly **flow out** to each recipient; on `raiseDispute()` the reserve turns **red and frozen**; on an anomaly it shows a **variance callout** and a blocked-release indicator; on `resolveDispute()` it splits along the resolved amounts. Pair with a 6-state status timeline and an audit log from indexed events, each row linking to the on-chain tx.

A judge should understand the whole product from this one screen.

---

## 10. Sponsor / bounty positioning

**Committed (load-bearing — remove any one and the project breaks):**
- **Arc** — the settlement contract; USDC/EURC programmable splits, conditional release, anomaly gating, dispute resolution. Primary submission: *Best Smart Contracts on Arc with Advanced Stablecoin Logic*.
- **Chainlink** — Functions as the delivery oracle feeding `markDelivered` / `reportActualDuties`.
- **Privy or Dynamic (one only)** — email/embedded-wallet onboarding for merchant and customer.

**Stretch only:**
- **LI.FI or 1inch (one)** — in-order USDC↔EURC conversion → unlocks Arc's *Chain Abstracted USDC* bounty.

Do not list more sponsors than are genuinely load-bearing. Judges discount bolt-ons.

---

## 11. Demo script (3 minutes)

**Open (30s):** "Cross-border ecommerce payments don't end at checkout. After the customer pays, the merchant still owes duties, refunds, rejected packages, creator commissions, platform fees — and has to reconcile all of it. StableSettle turns each order into a programmable settlement contract on Arc."

**Scenario A — normal (45s):** Show a USDC order. Fund it → the split animates into 4 buckets. Chainlink oracle marks delivered. `release()` → funds flow out. Show the settlement record and audit log.

**Scenario B — dispute (45s):** A EURC order. Funded, split. Package refused → `raiseDispute()` → reserve freezes red. Admin resolves with a split → contract executes exactly that. Show value conservation.

**Scenario C — anomaly (45s):** Estimated duties $8; oracle reports $80. Contract auto-flags; `release()` is blocked; reconciliation view shows the variance. "StableSettle caught a billing error before the money moved."

**Close (15s):** "Real on-chain logic, a real delivery oracle, full reconciliation. On Arc, stablecoins become programmable settlement infrastructure for real commerce."

---

## 12. Honest disclaimers (say before a judge asks)

- **Carrier API is mocked.** Chainlink Functions is real and the integration is real, but it calls a mock carrier endpoint, not a live courier. Disclosed.
- **Refund window is shortened** for the demo because on-chain time can't be fast-forwarded.
- **Not tax/legal advice, not a Merchant of Record.**
- Label anything simulated as simulated, in the UI and README.

---

## 13. Tech stack

- **Contracts:** Solidity, Foundry (incl. fuzz + invariant tests), OpenZeppelin (AccessControl, SafeERC20, ReentrancyGuard). `MockUSDC.sol`, `MockEURC.sol`, `StableSettleEscrow.sol`. Chainlink Functions consumer contract.
- **Backend:** Hono + Zod, RPC mode; standing indexer worker; SQLite for dev, Postgres if deploying.
- **Frontend:** TanStack Start + TanStack Router + TanStack Query; Tailwind + shadcn/ui; wagmi/viem; a charting lib for the dashboard.
- **Wallet:** wagmi to start; Privy or Dynamic layered in once the core flow works.
- **Deploy:** app + Hono on a Node-friendly host; contracts on Arc testnet (Arc-compatible EVM testnet as fallback).

---

## 14. Decisions locked

| Question | Decision |
|---|---|
| Product name | **StableSettle.** |
| Framework | **TanStack Start** (+ Router + Query). |
| Backend | **Hono** + Zod, RPC mode, with a **standing indexer worker**. |
| Currencies | **USDC and EURC** (per-order denomination). In-order conversion = stretch. |
| Scenarios | **Three:** normal, dispute, anomaly. |
| Delivery oracle | **Chainlink Functions** → mock carrier API. Admin button kept as dev fallback. |
| Committed sponsors | **Arc + Chainlink + (Privy or Dynamic).** |
| Customer wallet / payment | **Real wallet, real token transfer.** |
| Refund window | Time-based; short (0–60s) on demo orders. |
| Dispute resolution | Admin-only. |
| Cross-chain / in-order swap | **Stretch.** |

---

**The one-line message to land:** StableSettle turns stablecoins from a checkout method into programmable settlement infrastructure for cross-border commerce — proven by one readable contract, a real delivery oracle, and full reconciliation.