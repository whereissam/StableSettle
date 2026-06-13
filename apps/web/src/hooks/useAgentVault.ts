import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { isAddress, type Address } from 'viem'
import { readVault, readSpendHistory } from '@/lib/agentVault'

/** Live AgentVault state + recent spend history, read straight from the contract on Arc. */
export function useAgentVault(address?: string) {
  const client = usePublicClient()
  const valid = !!address && isAddress(address)
  return useQuery({
    queryKey: ['agentVault', address],
    enabled: !!client && valid,
    refetchInterval: 4000,
    queryFn: async () => {
      const addr = address as Address
      const [state, history] = await Promise.all([
        readVault(client!, addr),
        readSpendHistory(client!, addr).catch(() => []),
      ])
      return { state, history }
    },
  })
}
