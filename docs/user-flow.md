# StableSettle — User Flow

How a user moves through the app, from landing to a finalized settlement. All diagrams are
Mermaid (GitHub renders them inline). For the contract-level state machine see
[`smart-contracts.md`](smart-contracts.md); for the pitch beats see [`demo-script.md`](demo-script.md).

---

## 1. App navigation

The app is four screens. Everything reads live from contract events — there is no backend.

```mermaid
flowchart TD
    L["Landing<br/>(problem · solution · Launch demo)"]
    DM["Demo mode<br/>(step through A / B / C · reset)"]
    DB["Dashboard<br/>(volume · pending · reserves · disputed · anomaly alert)"]
    OD["Order detail<br/>(animated settlement · timeline · actions · audit log)"]

    L -->|Launch demo| DM
    L -->|View dashboard| DB
    DM -->|Watch settlement| OD
    DB -->|View an order| OD
    OD -->|back| DB
    DM -.connect wallet.-> W{{"Wallet<br/>(switches to Arc testnet)"}}
```

---

## 2. The core loop (any action)

Every button press follows the same shape: a real Arc transaction, then the UI re-reads
chain state and re-renders.

```mermaid
sequenceDiagram
    actor U as User
    participant APP as StableSettle app
    participant W as Wallet
    participant ESC as StableSettleEscrow (Arc)

    U->>APP: Click an action (fund / deliver / release / …)
    APP->>W: Request signature (wagmi)
    W->>ESC: Submit transaction (USDC gas)
    ESC-->>ESC: Update state + emit event
    ESC-->>APP: Tx confirmed (receipt)
    APP->>ESC: Re-read getOrder + replay events
    ESC-->>APP: Order state + audit log
    APP-->>U: Toast "confirmed" + animated UI update
```

---

## 3. Roles in the demo

One connected wallet plays every role (the contract still *enforces* who can call what).

```mermaid
flowchart LR
    subgraph Wallet["Connected wallet (demo)"]
      M["MERCHANT_ROLE"]
      O["ORACLE_ROLE"]
      A["ADMIN_ROLE"]
      C["Customer"]
    end
    M -->|createOrder| ESC[(Escrow)]
    C -->|approve + fundOrder| ESC
    O -->|markDelivered · reportActualDuties · raiseDispute| ESC
    A -->|resolveDispute · clearAnomaly| ESC
```

---

## 4. Scenario A — normal delivery

```mermaid
flowchart TD
    A1["Create order<br/>$100 → 85 / 8 / 5 / 2"] --> A2["Approve & fund<br/>USDC pulled into escrow"]
    A2 --> A3["Split animates into 4 buckets<br/>reserve renders Locked"]
    A3 --> A4["Mark delivered<br/>(oracle · simulated)"]
    A4 --> A5["Release<br/>(window = 0 for demo)"]
    A5 --> A6["Funds flow out<br/>reserve returns to customer · state Released"]
```

## 5. Scenario B — rejected package / dispute

```mermaid
flowchart TD
    B1["Create order"] --> B2["Approve & fund<br/>split into buckets"]
    B2 --> B3["Raise dispute<br/>(package refused)"]
    B3 --> B4["Reserve freezes red<br/>state Disputed"]
    B4 --> B5["Admin resolves<br/>$70 customer · $25 merchant · $5 platform"]
    B5 --> B6["Contract pays exact split<br/>value conserved · state Resolved"]
```

## 6. Scenario C — duties anomaly

```mermaid
flowchart TD
    C1["Create order<br/>estimated duties $10"] --> C2["Approve & fund → split"]
    C2 --> C3["Mark delivered"]
    C3 --> C4["Report actual duties $35<br/>(oracle · simulated)"]
    C4 --> C5{"actual > 2× estimate?"}
    C5 -->|yes| C6["Auto-flagged ⚠<br/>release BLOCKED · red banner"]
    C6 --> C7["Admin reviews → clear anomaly"]
    C7 --> C8["Release proceeds<br/>state Released"]
    C5 -->|no| C8
```

---

## 7. What the user sees on the order-detail centerpiece

```mermaid
flowchart TD
    subgraph Screen["Order detail"]
      H["Header: product · route · state badge · order hash → explorer"]
      T["6-state timeline (scrolls on mobile)"]
      S["Animated settlement: $100 → 4 buckets<br/>Locked / Paid / Refunded / Frozen · anomaly callout"]
      P["Actions panel (state-aware buttons)"]
      AL["Audit log: every contract event · each row → on-chain tx"]
    end
    H --> T --> S --> P --> AL
```

Each audit-log row links to the transaction on `testnet.arcscan.app`, so a judge can verify
every step on-chain without leaving the app.
