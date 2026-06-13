# StableSettle — 3-minute demo script

Practice this out loud at least twice. Rehearse the disclaimers (§ "Disclaimers") so you
say them *before* a judge asks.

Pre-flight (before you present):
- Wallet connected to Arc testnet, funded with USDC from <https://faucet.circle.com>.
- Contract deployed; `apps/web/src/deployments.json` populated; app running.
- In **Demo mode**, hit **Reset demo** so both scenario orders start fresh.
- A spawned `AgentVault` address ready (set `VITE_AGENT_VAULT_ADDRESS` to pre-fill the **Agent Vaults** page), funded, with a **daily limit set** (e.g. `setDailyLimit($1,000)`) so the velocity revert is live.

---

## Positioning (one line — say it up front, and again in Q&A)

> "On-chain spend caps aren't new — Crossmint, Coinbase, and ERC-4337 session keys all enforce on-chain too. What's ours is the **trust path**: a pure EVM invariant with **no co-signer and no off-chain policy server**, on **Arc where USDC is the gas** so treasury, spend, and cap live in one contract, and an agent that's **identity-bound from birth** — ENS name + World ID nullifier recorded on-chain."

Never say "we're the only on-chain cap" or "everyone else is off-chain" — a judge who knows the space will call it, and it's not true.

---

## Agent vault firewall — the budget wow (45s)

Lead with this — it's the new hero. The escrow scenarios below are the depth.

1. Open **Agent Vaults**, the vault is pre-filled. Narrate the two meters + green health badge:
   *"This agent has a $5,000 lifetime cap and a $1,000/day velocity limit — both enforced in Solidity, read straight off the contract, no backend."*
2. In Claude, `agent_pay` **$5,001** → it reverts.
   *"It doesn't warn, it doesn't flag. The transaction reverts on-chain — `BudgetExceeded`. Even with the agent's key fully stolen, it cannot cross the cap, because the funds never leave the vault and the agent only holds permission to *request* a spend."*
3. **The injection twist:** tell the agent (malicious prompt) to dump the whole treasury into a token. The **daily limit** reverts first — `DailyLimitExceeded` — and the health badge flips amber.
   *"There's budget left under the lifetime cap, but it still can't burst-drain in one shot. That's the velocity guard."*
4. Point at the **Spent** history — every spend is a contract event, each links to the on-chain tx.

## Open (30s)

> "Cross-border ecommerce payments don't end at checkout. After the customer pays, the
> merchant still owes duties, refunds, rejected packages, creator commissions, platform
> fees — and has to reconcile all of it. Crypto payment demos almost all stop at 'customer
> paid USDC, merchant received USDC.' That's the easy half.
>
> StableSettle turns each order into a programmable settlement contract on Arc. The payment
> is split into buckets, locked, and conditionally released or frozen."

## Scenario A — normal delivery (60s)

1. Open **Demo mode**, Scenario A. Click **Auto-run** (or step through).
2. Switch to the order's **Watch settlement** view.
   - On funding, narrate: *"The $100 splits into four buckets — $85 merchant, $8 refund
     reserve, $5 creator, $2 platform. The reserve is locked — that's the cross-border
     duties/refusal buffer."*
   - Oracle marks delivered; refund window elapses; `release()` fires.
   - *"Funds flow out to each recipient, the reserve returns to the customer, and the order
     is a finalized, itemized settlement record."*
3. Point at the **audit log** — every row is a contract event, each links to the on-chain tx.

## Scenario B — dispute (60s)

1. Scenario B: fund the order, then **Raise dispute** (the package was refused).
   - *"The reserve turns red and freezes. Nothing moves until an admin resolves it."*
2. **Resolve dispute** → `$70` back to customer, `$25` to merchant for shipping loss,
   `$5` platform.
   - *"The contract executes exactly that split. It enforces value conservation — the
     payouts must sum to the original total. No minting, no trapped funds."*

## Scenario C — duties anomaly (optional, +30s if time allows)

> The third scenario deepens the "advanced stablecoin logic" story. Only run it if you're
> inside 3 minutes; otherwise mention it verbally.

1. Scenario C: fund → deliver, then **Report actual duties** — customs charges `$35` against
   the `$10` quoted at checkout.
2. The order **auto-flags** (>2× the estimate) and `release()` is blocked — point at the red
   "duties anomaly — release blocked" banner.
   - *"The contract itself enforces the rule: if actual duties blow past the estimate, funds
     don't auto-release — they hold for review. No off-chain trust required."*
3. **Clear anomaly** (admin review) → `release()` proceeds normally.

## Close (30s)

> "Delivery status here is simulated through an admin action — production would use a
> carrier oracle like Chainlink Functions. Everything else is real on-chain logic: real
> USDC transfers, real access control, real value-conservation invariants. Stablecoins
> aren't just a payment method — on Arc they become programmable settlement infrastructure
> for real commerce."

## Q&A defense — "how are you different from Crossmint / Coinbase?"

> "Their on-chain policies are genuinely strong — we agree, and we don't claim to have invented on-chain spend caps. Three things are ours: **one**, the trust path has no co-signer and no off-chain policy server — it's a pure EVM invariant, so `spend()` reverts unconditionally even if the agent key is stolen. **Two**, it's Arc-native: USDC is the gas, so the treasury, the spend, and the cap all live in one USDC contract — no second gas token, no bridge friction on enforcement. **Three**, every agent is identity-bound from spawn — ENS name plus a World ID nullifier recorded on-chain — so it's a sybil-resistant, human-backed treasury, not just a key with a limit. Plus a full settlement engine, not just payments."

If asked "what's *not* on-chain?": the World ID proof is cloud-verified (Arc has no World ID Router) and the nullifier is recorded on-chain; the delivery/duties oracle is a simulated admin action. Say it before they dig.

## Disclaimers (say these before a judge asks)

- The **delivery oracle is simulated** (admin action, not a real carrier).
- The **refund window is shortened** for the demo; on-chain time can't be fast-forwarded.
- StableSettle is **settlement infrastructure** — not tax/legal advice, not a Merchant of
  Record, and it does not calculate real duties or touch card chargebacks.
