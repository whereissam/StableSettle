import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { Button } from '@/components/ui/button'
import { shortenAddress } from '@/lib/format'
import { ARC_CHAIN } from '@/lib/wagmi'
import { Wallet, AlertTriangle } from 'lucide-react'

export function WalletButton() {
  const { address, isConnected, chainId } = useAccount()
  const { connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()

  if (!isConnected) {
    return (
      <Button onClick={() => connect({ connector: injected() })} disabled={isPending}>
        <Wallet className="mr-2 h-4 w-4" />
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </Button>
    )
  }

  const wrongChain = chainId !== ARC_CHAIN.id

  if (wrongChain) {
    return (
      <Button variant="destructive" onClick={() => switchChain({ chainId: ARC_CHAIN.id })}>
        <AlertTriangle className="mr-2 h-4 w-4" />
        Switch to Arc
      </Button>
    )
  }

  return (
    <Button variant="outline" onClick={() => disconnect()}>
      <span className="mr-2 h-2 w-2 rounded-full bg-success" />
      {shortenAddress(address)}
    </Button>
  )
}
