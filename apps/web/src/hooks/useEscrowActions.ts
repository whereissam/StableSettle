import { useState, useCallback } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { Address } from 'viem'
import { escrowAbi, erc20Abi, ESCROW_ADDRESS, USDC_ADDRESS, txUrl, tokenMeta } from '@/lib/contract'
import { DEMO_REFUND_WINDOW_SECONDS, DEMO_TOTAL, buildSplit } from '@/lib/demo'

interface CreateArgs {
  orderId: `0x${string}`
  productName: string
  customerCountry: string
  estimatedDuties?: bigint
  token?: Address // settlement token; defaults to USDC
}

/**
 * All escrow write actions, each wrapped with toast feedback, receipt waiting,
 * and query invalidation so the dashboard/order views refresh after a tx confirms.
 */
export function useEscrowActions() {
  const { address } = useAccount()
  const client = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<string | null>(null)

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['orders'] })
    queryClient.invalidateQueries({ queryKey: ['order'] })
  }, [queryClient])

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
        invalidate()
        return hash
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : 'Transaction failed'
        toast.error(`${label} failed`, { id: toastId, description: msg })
        throw err
      } finally {
        setPending(null)
      }
    },
    [client, invalidate],
  )

  // ── reads (token-aware) ──────────────────────────────────────────────────────
  const getAllowance = useCallback(
    async (token: Address = USDC_ADDRESS): Promise<bigint> => {
      if (!address) return 0n
      return (await client!.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, ESCROW_ADDRESS],
      })) as bigint
    },
    [address, client],
  )

  const getBalance = useCallback(
    async (token: Address = USDC_ADDRESS): Promise<bigint> => {
      if (!address) return 0n
      return (await client!.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      })) as bigint
    },
    [address, client],
  )

  // ── writes ───────────────────────────────────────────────────────────────────
  const mint = (amount: bigint, token: Address = USDC_ADDRESS) =>
    run(`Mint ${tokenMeta(token).symbol}`, () =>
      writeContractAsync({
        address: token,
        abi: erc20Abi,
        functionName: 'mint',
        args: [address as Address, amount],
      }),
    )

  const createOrder = ({
    orderId,
    productName,
    customerCountry,
    estimatedDuties = 0n,
    token = USDC_ADDRESS,
  }: CreateArgs) =>
    run('Create order', () => {
      const me = address as Address
      const split = buildSplit({ merchant: me, creator: me, platform: me, customer: me })
      return writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: 'createOrder',
        args: [
          orderId,
          DEMO_TOTAL,
          DEMO_REFUND_WINDOW_SECONDS,
          estimatedDuties,
          token,
          split,
          productName,
          customerCountry,
        ],
      })
    })

  const approveAndFund = async (orderId: `0x${string}`, token: Address = USDC_ADDRESS) => {
    const allowance = await getAllowance(token)
    if (allowance < DEMO_TOTAL) {
      await run(`Approve ${tokenMeta(token).symbol}`, () =>
        writeContractAsync({
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [ESCROW_ADDRESS, DEMO_TOTAL],
        }),
      )
    }
    return run('Fund order', () =>
      writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: 'fundOrder',
        args: [orderId],
      }),
    )
  }

  const markDelivered = (orderId: `0x${string}`) =>
    run('Mark delivered', () =>
      writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: 'markDelivered',
        args: [orderId],
      }),
    )

  const release = (orderId: `0x${string}`) =>
    run('Release funds', () =>
      writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: 'release',
        args: [orderId],
      }),
    )

  const reportActualDuties = (orderId: `0x${string}`, actualDuties: bigint) =>
    run('Report actual duties', () =>
      writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: 'reportActualDuties',
        args: [orderId, actualDuties],
      }),
    )

  const clearAnomaly = (orderId: `0x${string}`) =>
    run('Clear anomaly', () =>
      writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: 'clearAnomaly',
        args: [orderId],
      }),
    )

  const raiseDispute = (orderId: `0x${string}`) =>
    run('Raise dispute', () =>
      writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: 'raiseDispute',
        args: [orderId],
      }),
    )

  const resolveDispute = (
    orderId: `0x${string}`,
    payout: { toCustomer: bigint; toMerchant: bigint; toCreator: bigint; toPlatform: bigint },
  ) =>
    run('Resolve dispute', () =>
      writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: 'resolveDispute',
        args: [orderId, payout.toCustomer, payout.toMerchant, payout.toCreator, payout.toPlatform],
      }),
    )

  return {
    pending,
    getAllowance,
    getBalance,
    mint,
    createOrder,
    approveAndFund,
    markDelivered,
    release,
    reportActualDuties,
    clearAnomaly,
    raiseDispute,
    resolveDispute,
  }
}
