# StableSettle API

The Hono backend (`apps/api`) is an **optional** read layer. The frontend defaults to
reading contract events directly from Arc; set `VITE_API_URL` in `apps/web/.env` to route
order/audit/dashboard reads through this API + Postgres indexer instead.

- **Source:** `apps/api/src/app.ts` (routes), `packages/shared/src/dto.ts` (response shapes)
- **Data source:** Postgres, populated by the standing indexer worker (`apps/indexer`), which
  polls the 8 escrow events and upserts orders + appends the mirrored event log + recomputes
  reconciliation. The API itself never reads the chain — it only serves the indexed DB.
- **Type-safe client:** the route chain is one fluent expression so `AppType` is inferred; the
  frontend consumes it via `hc<AppType>(API_URL)` (`apps/web/src/lib/api.ts`).

## Running

```bash
docker compose up -d postgres        # Postgres for the indexer + API
bun run dev:api                      # API on http://localhost:8787
bun run dev:indexer                  # standing event worker that fills the DB
```

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | API listen port |
| `WEB_ORIGIN` | `http://localhost:5173` | CORS allow-origin (the web app) |

CORS allows `GET`, `POST`, `OPTIONS` from `WEB_ORIGIN` only.

## Conventions

- **All on-chain amounts are decimal strings** in JSON (USDC/EURC are 6-decimal; `bigint`
  isn't JSON-safe). E.g. `"85000000"` = 85.00 USDC. Convert on the client.
- `orderId` is the `bytes32` hex string from the contract.
- `state` is one of `Created · Funded · Delivered · Released · Disputed · Resolved`
  (`stateIndex` is the matching 0–5 Solidity enum index).
- Audit `event` is one of `OrderCreated · OrderFunded · Delivered · ActualDutiesReported ·
  AnomalyCleared · Released · DisputeRaised · DisputeResolved`.

## Endpoints

### `GET /health`
Liveness check.
```json
{ "ok": true }
```

### `GET /orders`
All orders, newest-updated first.
```json
{ "orders": [ OrderDTO, ... ] }
```

### `GET /orders/:orderId`
One order plus its full event-sourced audit log (chronological by block, then log index).
`404 { "error": "not found" }` if the order isn't indexed.
```json
{ "order": OrderDTO, "audit": [ AuditEntryDTO, ... ] }
```

### `POST /orders/:orderId/metadata`
Attach off-chain metadata (product name, customer country, note) to an order — fields the
contract doesn't store. Upserts; all fields optional. Validated by `orderMetadataSchema`.
```json
// request body
{ "productName": "string (1–120)", "customerCountry": "string (1–80)", "note": "string (≤500)" }
// 200
{ "ok": true }
// 400 — Zod flattened error
{ "error": { "formErrors": [], "fieldErrors": { ... } } }
```

### `GET /dashboard`
Aggregate stats across all indexed orders.
```json
DashboardStatsDTO
```
- `volumeSettled` — total of `Released` + `Resolved` orders
- `fundsPending` — total still in escrow (`Funded` + `Delivered`)
- `reservesLocked` — refund reserves on pending orders
- `disputedAmount` — total of `Disputed` orders
- `anomalyCount` — orders with `anomalyFlagged`
- `orderCount` — total orders

### `GET /reconciliation/:orderId`
Duties variance + expected-vs-actual payout for one order. `404` if not yet computed.
```json
ReconciliationDTO
```
- `dutiesVarianceRatio` — `actualDuties / estimatedDuties` (`null` when estimate is 0)
- `expectedPayout` — bucket → planned amount
- `actualPayout` — recipient → amount actually paid (once settled)
- `mismatch` — true when actual diverges from expected

### `GET /indexer/status`
Indexer health and cursor.
```json
IndexerStatusDTO
```
- `lastBlock` — last block the indexer processed (its resumable cursor)
- `chainId`, `escrow` — what it's indexing
- `healthy` — whether indexer state exists

## Response shapes

Authoritative definitions live in `packages/shared/src/dto.ts` (shared by both sides).

### OrderDTO
```ts
{
  orderId, productName, customerCountry, note,        // metadata (note: string | null)
  totalAmount, refundWindowSeconds,                   // decimal strings
  estimatedDuties, actualDuties, deliveredAt,         // decimal strings
  anomalyFlagged, settled,                            // booleans
  token,                                              // settlement token address (USDC | EURC)
  state, stateIndex,                                  // OrderState + 0–5 index
  merchant, creator, platform, customer,              // party addresses
  merchantAmount, refundReserve,                      // the 4 split buckets (decimal strings)
  creatorCommission, platformFee,
  createdBlock, updatedAt                             // updatedAt is ISO-8601
}
```

### AuditEntryDTO
```ts
{ event, blockNumber, txHash, logIndex, args, timestamp }
// args: Record<string, string | boolean> — amounts are decimal strings
// timestamp: ISO-8601 string | null
```

### DashboardStatsDTO
```ts
{ volumeSettled, fundsPending, reservesLocked, disputedAmount, anomalyCount, orderCount }
```

### ReconciliationDTO
```ts
{ orderId, estimatedDuties, actualDuties, dutiesVarianceRatio,
  expectedPayout, actualPayout, mismatch, computedAt }
```

### IndexerStatusDTO
```ts
{ lastBlock, chainId, escrow, healthy }
```
