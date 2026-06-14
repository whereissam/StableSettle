import { createConfig, fallback, http } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'

/**
 * Official Arc testnet RPC endpoints (docs.arc.network/references/rpc-endpoints).
 * The Circle endpoint rate-limits aggressively (HTTP 429) under the dashboard's polling, so it's
 * listed last and `rank` lets viem route around any endpoint that starts failing or slowing down.
 * Override with VITE_ARC_RPC_URL to pin a single (e.g. private/keyed) provider.
 */
const ARC_RPCS = [
  'https://rpc.drpc.testnet.arc.network', // dRPC
  'https://rpc.quicknode.testnet.arc.network', // QuickNode
  'https://rpc.blockdaemon.testnet.arc.network', // Blockdaemon
  'https://rpc.testnet.arc.network', // Circle (rate-limited → last resort)
]

const override = import.meta.env.VITE_ARC_RPC_URL as string | undefined

// Batch JSON-RPC calls into single HTTP requests (fewer round-trips → far less likely to hit 429),
// and cap per-endpoint retries so a 429 fails over to a healthy provider quickly instead of hammering.
const httpOpts = { batch: true, retryCount: 1 } as const

/**
 * wagmi config for Arc testnet. arcTestnet ships with viem, so no custom chain
 * definition is required (chain id 5042002, USDC-native gas).
 */
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: override
      ? http(override, httpOpts)
      : // rank: continuously sample endpoints and prefer the fastest/healthiest, demoting any that 429.
        fallback(
          ARC_RPCS.map((url) => http(url, httpOpts)),
          { rank: { interval: 30_000, sampleCount: 3 } },
        ),
  },
})

export const ARC_CHAIN = arcTestnet

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
