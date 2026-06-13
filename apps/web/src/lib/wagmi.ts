import { createConfig, fallback, http } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'

/**
 * Official Arc testnet RPC endpoints (docs.arc.network/references/rpc-endpoints).
 * Primary first; the rest are fallbacks for resilience during the demo.
 * Override with VITE_ARC_RPC_URL to pin a single provider.
 */
const ARC_RPCS = [
  'https://rpc.testnet.arc.network', // Circle (primary)
  'https://rpc.drpc.testnet.arc.network', // dRPC
  'https://rpc.quicknode.testnet.arc.network', // QuickNode
  'https://rpc.blockdaemon.testnet.arc.network', // Blockdaemon
]

const override = import.meta.env.VITE_ARC_RPC_URL as string | undefined

/**
 * wagmi config for Arc testnet. arcTestnet ships with viem, so no custom chain
 * definition is required (chain id 5042002, USDC-native gas).
 */
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: override ? http(override) : fallback(ARC_RPCS.map((url) => http(url))),
  },
})

export const ARC_CHAIN = arcTestnet

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
