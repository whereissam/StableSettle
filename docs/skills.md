> ## Documentation Index
> Fetch the complete documentation index at: https://docs.arc.io/llms.txt
> Use this file to discover all available pages before exploring further.

# AI skills for building on Arc

> Use Circle's open source AI skills to accelerate development on Arc with AI-assisted IDEs.

Skills give AI coding tools specialized knowledge for building on Arc and with
Circle's products, including USDC, agent wallets, crosschain transfers, and
smart contracts.

Skills are available in the
[circlefin/skills](https://github.com/circlefin/skills) repository.

## Installation

Install Circle Skills with the command-line.

<CodeGroup>
  ```shell Claude Code icon="https://mintcdn.com/arcio-docs/DcVxxFlqh75sTiVQ/images/claude-logo.png?fit=max&auto=format&n=DcVxxFlqh75sTiVQ&q=85&s=b0262a5319054feab00173c330431e02" theme={null}
  /plugin marketplace add circlefin/skills
  /plugin install circle-skills@circle
  ```

  ```shell Vercel Skills CLI icon="https://mintcdn.com/arcio-docs/DcVxxFlqh75sTiVQ/images/vercel_logo.png?fit=max&auto=format&n=DcVxxFlqh75sTiVQ&q=85&s=9a66052e003d6b18378e0d8a1e0f35f5" theme={null}
  npx skills add circlefin/skills
  ```
</CodeGroup>

## Available skills

| Skill                                                                                                                                                 | What it covers                                                               |
| :---------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------- |
| [`use-arc`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-arc/SKILL.md)                                                   | Chain config, contract deployment, viem/wagmi integration, bridging via CCTP |
| [`use-circle-cli`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-circle-cli/SKILL.md)                                     | Unified CLI for agent wallets, x402 payments, and crosschain transfers       |
| [`use-agent-wallet`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-agent-wallet/SKILL.md)                                 | Email/OTP login, wallet creation, status checks, balance inspection          |
| [`fund-agent-wallet`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/fund-agent-wallet/SKILL.md)                               | Fund with USDC via fiat on-ramp, crypto transfer, or Gateway deposit         |
| [`agent-wallet-policy`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/agent-wallet-policy/SKILL.md)                           | View and reset per-tx, daily, weekly, and monthly USDC spending caps         |
| [`pay-via-agent-wallet`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/pay-via-agent-wallet/SKILL.md)                         | Pay paid APIs in USDC via x402 (search, market data, weather, news, sports)  |
| [`use-usdc`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-usdc/SKILL.md)                                                 | Balances, transfers, approvals, verification across EVM and Solana           |
| [`bridge-stablecoin`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/bridge-stablecoin/SKILL.md)                               | CCTP bridging with App Kit, progress tracking, EVM and Solana                |
| [`swap-tokens`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/swap-tokens/SKILL.md)                                           | Same-chain swaps via App Kit or Swap Kit; combine with bridge for crosschain |
| [`use-gateway`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-gateway/SKILL.md)                                           | Gateway unified balance for sub-500ms crosschain transfers                   |
| [`unify-balance`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/unify-balance/SKILL.md)                                       | Crosschain USDC balance via App Kit or Unified Balance Kit                   |
| [`use-circle-wallets`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-circle-wallets/SKILL.md)                             | Choose between developer-controlled, user-controlled, and modular wallets    |
| [`use-developer-controlled-wallets`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-developer-controlled-wallets/SKILL.md) | Custodial wallets for payouts, treasury, subscriptions, automation           |
| [`use-user-controlled-wallets`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-user-controlled-wallets/SKILL.md)           | Embedded wallets with social login or OTP/PIN, no seed phrases               |
| [`use-modular-wallets`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-modular-wallets/SKILL.md)                           | Passkey auth and gasless transactions; ERC-4337 and ERC-6900                 |
| [`use-smart-contract-platform`](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-smart-contract-platform/SKILL.md)           | Deploy/import/call/monitor contracts; ERC-20/721/1155 templates              |
