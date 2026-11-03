import { useQuery } from '@tanstack/react-query'
import { resolveAgentEns } from '@/lib/ens'

/**
 * Resolve an agent's ENS name live (address + spend-policy text records) via a standard CCIP-Read
 * ENS client. The name comes from the vault's on-chain `agentName`; this reads it back through public
 * ENS infrastructure to prove the round-trip. Only runs for a dotted name (e.g. foo.stablesettle.eth).
 */
export function useAgentEns(name?: string) {
  return useQuery({
    queryKey: ['agentEns', name],
    enabled: !!name && name.includes('.'),
    staleTime: 60_000,
    queryFn: () => resolveAgentEns(name as string),
  })
}
