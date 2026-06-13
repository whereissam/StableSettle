import { useState } from 'react'
import { isAddress, type Address } from 'viem'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { BudgetMeter } from '@/components/budget-meter'
import { StatCard } from '@/components/stat-card'
import { useAgentVault } from '@/hooks/useAgentVault'
import { useFundVault } from '@/hooks/useFundVault'
import { UINT256_MAX, type VaultHealth } from '@/lib/agentVault'
import { addressUrl, txUrl } from '@/lib/contract'
import { formatUsd, shortenAddress, shortenHash, toUsdcUnits } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ShieldCheck, ShieldAlert, ShieldX, ExternalLink, Wallet } from 'lucide-react'

const DEFAULT_VAULT = (import.meta.env.VITE_AGENT_VAULT_ADDRESS as string | undefined) ?? ''

const HEALTH_META: Record<
  VaultHealth,
  { label: string; className: string; Icon: typeof ShieldCheck }
> = {
  healthy: { label: 'Healthy', className: 'bg-success/10 text-success border-success/30', Icon: ShieldCheck },
  warning: { label: 'Near limit', className: 'bg-reserve/10 text-reserve border-reserve/30', Icon: ShieldAlert },
  frozen: { label: 'Frozen — agent revoked', className: 'bg-danger/10 text-danger border-danger/30', Icon: ShieldX },
}

export function AgentsPage() {
  const [input, setInput] = useState(DEFAULT_VAULT)
  const valid = isAddress(input)
  const { data, isLoading, error } = useAgentVault(valid ? input : undefined)
  const v = data?.state
  const history = data?.history ?? []
  const hasDaily = !!v && v.dailyLimit > 0n
  const health = v ? HEALTH_META[v.health] : null

  const [fundAmount, setFundAmount] = useState('')
  const { fund, pending: funding, connected } = useFundVault(valid ? (input as Address) : undefined)
  const fundValid = Number(fundAmount) > 0

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agent Vaults</h1>
        <p className="text-sm text-muted-foreground">
          The on-chain firewall for autonomous agents. Budget cap, daily velocity limit, and health are
          read straight from <code className="rounded bg-secondary px-1">AgentVault</code> on Arc — no backend.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <label className="text-xs font-medium text-muted-foreground">Vault address</label>
          <div className="mt-1.5 flex items-center gap-2">
            <Wallet className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value.trim())}
              placeholder="0x… vault address from arc:spawn-agent"
              spellCheck={false}
              className="flex-1 rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {input.length > 0 && !valid && (
            <p className="mt-2 text-xs text-danger">Not a valid address.</p>
          )}
        </CardContent>
      </Card>

      {!valid && (
        <div className="rounded-xl border border-dashed py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Paste a vault address to inspect its budget, daily limit, and live spend history.
          </p>
        </div>
      )}

      {valid && isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {valid && error && (
        <div className="rounded-xl border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          Couldn't read this vault. Is the address an AgentVault on Arc testnet?
        </div>
      )}

      {v && health && (
        <>
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
              <div>
                <CardTitle className="text-base">{v.agentName || 'Unnamed agent'}</CardTitle>
                <a
                  href={addressUrl(v.address)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                >
                  {shortenAddress(v.address)} <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <Badge className={cn('gap-1.5 border', health.className)}>
                <health.Icon className="h-3.5 w-3.5" />
                {health.label}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-6">
              <BudgetMeter
                label="Lifetime budget cap"
                used={v.spent}
                total={v.budgetCap}
                accent={v.health === 'warning' ? 'warning' : 'primary'}
                hint={`${formatUsd(v.capRemaining)} remaining · enforced in Solidity — an over-cap spend reverts`}
              />
              {hasDaily && (
                <BudgetMeter
                  label="Daily velocity limit (24h)"
                  used={v.dailyLimit - (v.todayRemaining > v.dailyLimit ? v.dailyLimit : v.todayRemaining)}
                  total={v.dailyLimit}
                  accent="warning"
                  hint={`${formatUsd(v.todayRemaining)} left in this window · caps burst spend even under the lifetime cap`}
                />
              )}

              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label="Vault balance" value={formatUsd(v.balance)} hint="USDC held in the vault" />
                <StatCard
                  label="Cap remaining"
                  value={formatUsd(v.capRemaining)}
                  hint="Spendable under the lifetime cap"
                  accent={v.health === 'warning' ? 'warning' : 'success'}
                />
                <StatCard
                  label="Daily remaining"
                  value={hasDaily ? formatUsd(v.todayRemaining > UINT256_MAX / 2n ? 0n : v.todayRemaining) : '—'}
                  hint={hasDaily ? 'Left in the current 24h window' : 'No daily limit set'}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Fund this vault</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Top up from <span className="font-medium text-foreground">your own connected wallet</span> — USDC
                moves straight to the vault via <code className="rounded bg-secondary px-1">fund()</code>.
                Non-custodial: no server key touches your money.
              </p>
              <div className="flex items-center gap-2">
                <input
                  value={fundAmount}
                  onChange={(e) => setFundAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder="Amount in USDC, e.g. 100"
                  className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <Button
                  disabled={!connected || !!funding || !fundValid}
                  onClick={() => fund(toUsdcUnits(fundAmount)).then(() => setFundAmount(''))}
                >
                  {funding ?? 'Approve + Fund'}
                </Button>
              </div>
              {!connected && (
                <p className="text-xs text-muted-foreground">Connect your wallet (top right) to fund.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent spends</CardTitle>
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No spends in the recent window. Spends appear here as <code className="rounded bg-secondary px-1">Spent</code>{' '}
                  events the moment the agent pays.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>To</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Remaining after</TableHead>
                      <TableHead className="text-right">Tx</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((s, i) => (
                      <TableRow key={`${s.txHash}-${i}`}>
                        <TableCell className="font-mono text-xs">{shortenAddress(s.to)}</TableCell>
                        <TableCell className="text-right tabular font-medium">{formatUsd(s.amount)}</TableCell>
                        <TableCell className="text-right tabular text-muted-foreground">
                          {formatUsd(s.remaining)}
                        </TableCell>
                        <TableCell className="text-right">
                          <a
                            href={txUrl(s.txHash)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                          >
                            {shortenHash(s.txHash)} <ExternalLink className="h-3 w-3" />
                          </a>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
