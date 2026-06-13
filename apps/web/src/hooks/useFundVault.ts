import { useState, useCallback } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { Address } from 'viem'
import { erc20Abi, USDC_ADDRESS, txUrl } from '@/lib/contract'
import { agentVaultAbi } from '@/lib/agentVault'

/**
 * Fund an AgentVault from the *connected user's own wallet* — the non-custodial path.
 * `fund()` pulls USDC from msg.sender, so we approve the vault first if needed, then call fund().
 * No server key touches the money; the user signs both txs in their wallet.
 */
export function useFundVault(vault?: Address) {
  const { address } = useAccount()
  const client = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<string | null>(null)

  const run = useCallback(
    async (label: string, fn: () => Promise<`0x${string}`>) => {
      setPending(label)
      const toastId = toast.loading(`${label}…`)
      try {
        const hash = await fn()
        toast.loading(`${label}: confirming…`, { id: toastId })
        await client!.waitForTransactionReceipt({ hash })
        toast.success(`${label} confirmed`, {
          id: toastId,
          action: { label: 'View tx', onClick: () => window.open(txUrl(hash), '_blank') },
        })
        return hash
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : 'Transaction failed'
        toast.error(`${label} failed`, { id: toastId, description: msg })
        throw err
      } finally {
        setPending(null)
      }
    },
    [client],
  )

  const fund = useCallback(
    async (amountUnits: bigint) => {
      if (!vault || !address || amountUnits <= 0n) return
      // Approve the vault to pull `amountUnits` of USDC, if the current allowance is short.
      const allowance = (await client!.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, vault],
      })) as bigint
      if (allowance < amountUnits) {
        await run('Approve USDC', () =>
          writeContractAsync({
            address: USDC_ADDRESS,
            abi: erc20Abi,
            functionName: 'approve',
            args: [vault, amountUnits],
          }),
        )
      }
      await run('Fund vault', () =>
        writeContractAsync({ address: vault, abi: agentVaultAbi, functionName: 'fund', args: [amountUnits] }),
      )
      // Refresh the vault dashboard (balance + health) after funding.
      queryClient.invalidateQueries({ queryKey: ['agentVault'] })
    },
    [vault, address, client, writeContractAsync, run, queryClient],
  )

  return { fund, pending, connected: !!address }
}
