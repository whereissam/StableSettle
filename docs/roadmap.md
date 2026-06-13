# Roadmap

What's shipped, and what's deliberately *not* — so a reviewer can see we know the production path and chose hackathon scope on purpose.

## Shipped

- **Lifetime budget cap** — `spend()` reverts `BudgetExceeded` above the cap. Pure Solidity invariant.
- **Daily velocity limit** — optional rolling 24h ceiling (`setDailyLimit`, default off), reverts `DailyLimitExceeded`, auto-resets per window. Stops burst-drain even under the lifetime cap.
- **On-chain health view** — `health()` → `(status, capRemaining, todayRemaining)` for backend-free monitoring.
- **Identity + provenance** — ENS subname (NameStone) + World ID nullifier recorded on-chain at spawn.
- **Settlement engine** — `StableSettleEscrow`: multi-bucket splits, refund reserves, disputes, duties-anomaly flag.
- **Value-conserving protocol fee** — off by default, ≤ 1%, can shave the protocol's cut but never overspend the budget.
- **Frontend** — Agent Vaults dashboard (budget + velocity meters, health badge, live `Spent` history) + escrow demo flow.
- **76 Foundry tests** including a stateful invariant run.

## Next (post-hackathon, prioritized)

These came out of reviewer feedback. They're real production features, not demo-night work — listed here so the scope decision is explicit.

1. **Recipient allowlist / blocklist** — per-vault allowed payees, enforced in `spend()`. Cheapest high-value policy add; pairs with the existing caps. (Crossmint/Coinbase ship this.)
2. **Per-transaction max size** — a single-spend ceiling alongside the daily/lifetime caps.
3. **Session keys (ERC-4337)** — short-lived, scoped agent authority instead of a long-lived `AGENT_ROLE`, to shrink blast radius on key compromise. Needs an Arc bundler/EntryPoint; gated on Arc AA support.
4. **Pausable + timelock on owner actions** — `pause()` for incident response; a timelock on `setCap`/fee changes for enterprise multisig owners.
5. **Yield on idle float** — owner-gated `sweepToYield()` to a low-risk RWA/yield source; protocol takes a cut of *yield only*, never principal. Gated on a real Arc-native yield venue (mocking it would be dishonest in a demo).
6. **Multi-agent / sub-budgets** — a parent vault delegating capped sub-budgets to child agents; agent-to-agent payment via escrow.
7. **Monitoring** — indexer-driven spend-velocity graphs and near-cap webhooks/email to the human owner.
8. **Security hardening** — external audit + expanded invariant/formal-verification coverage before any mainnet/enterprise deployment.

## Explicitly out of scope (and why)

- **Memecoin/token-launch marketing agent** — gimmicky for an enterprise-treasury thesis; dilutes the firewall story.
- **Real duties/customs + chargebacks** — StableSettle is settlement infrastructure, not a Merchant of Record or tax engine. The oracle is simulated on purpose (see README → *What is simulated*).
