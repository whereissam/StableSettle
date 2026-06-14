import { Link, useRouterState } from '@tanstack/react-router'
import { WalletButton } from './wallet-button'
import { cn } from '@/lib/utils'
import { USDC_IS_MOCK, isConfigured } from '@/lib/contract'

const NAV = [
  { to: '/agents', label: 'Agent Vaults' },
  { to: '/dashboard', label: 'Dashboard' },
]

function NavLink({ to, label, pathname }: { to: string; label: string; pathname: string }) {
  const active = pathname.startsWith(to)
  return (
    <Link
      to={to}
      className={cn(
        'whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </Link>
  )
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { location } = useRouterState()

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-card/80 backdrop-blur">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-center gap-8">
            <Link to="/" className="flex items-center gap-2">
              <img src="/logo.jpg" alt="StableSettle" className="h-8 w-8 rounded-lg object-cover" />
              <span className="text-lg font-semibold tracking-tight">StableSettle</span>
              <span className="hidden rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground sm:inline">
                Arc testnet
              </span>
            </Link>
            <nav className="hidden items-center gap-1 md:flex">
              {NAV.map((item) => (
                <NavLink key={item.to} to={item.to} label={item.label} pathname={location.pathname} />
              ))}
            </nav>
          </div>
          <WalletButton />
        </div>

        {/* Mobile nav row */}
        <nav className="container flex items-center gap-1 overflow-x-auto pb-3 md:hidden">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} label={item.label} pathname={location.pathname} />
          ))}
        </nav>
      </header>

      {!isConfigured && (
        <div className="border-b bg-accent text-accent-foreground">
          <div className="container py-2 text-sm">
            ⚠️ No contract address configured. Deploy the escrow and set{' '}
            <code className="rounded bg-accent-foreground/10 px-1">VITE_ESCROW_ADDRESS</code> (or run the
            deploy script, which writes <code className="rounded bg-accent-foreground/10 px-1">deployments.json</code>).
          </div>
        </div>
      )}

      <main className="container py-8">{children}</main>

      <footer className="border-t">
        <div className="container flex flex-col gap-1 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            StableSettle — programmable settlement on Arc. Settlement infrastructure, not tax/legal
            advice or a Merchant of Record.
          </p>
          <p>
            Delivery oracle is <span className="font-medium">simulated</span> via an admin action
            {USDC_IS_MOCK ? ' · using MockUSDC' : ' · using Arc USDC'}.
          </p>
        </div>
      </footer>
    </div>
  )
}
