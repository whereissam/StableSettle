import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { ArrowRight, Lock, GitBranch, ScrollText } from 'lucide-react'

export function LandingPage() {
  return (
    <div className="mx-auto max-w-3xl py-12 text-center">
      <span className="inline-flex items-center rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
        Settlement of Record · built on Arc
      </span>
      <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-5xl">
        Cross-border payments don&apos;t end at checkout.
      </h1>
      <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
        After the customer pays, the merchant still owes duties, refunds, rejected packages, creator
        commissions, and platform fees — then has to reconcile all of it. StableSettle turns each
        order into a programmable settlement contract: the payment is split into buckets, locked, and
        conditionally released or frozen — verifiably, on-chain.
      </p>

      <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
        <Button asChild size="lg">
          <Link to="/demo">
            Launch demo <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link to="/dashboard">View dashboard</Link>
        </Button>
      </div>

      <div className="mt-16 grid gap-6 text-left sm:grid-cols-3">
        <Feature
          icon={<GitBranch className="h-5 w-5" />}
          title="Split on funding"
          body="$100 splits into merchant, refund reserve, creator, and platform buckets the moment it&apos;s funded."
        />
        <Feature
          icon={<Lock className="h-5 w-5" />}
          title="Reserve held back"
          body="A refund reserve is locked to cover duties and refusals — released to the customer only if delivery sticks."
        />
        <Feature
          icon={<ScrollText className="h-5 w-5" />}
          title="Audit log from chain"
          body="Every action is a contract event. The settlement record is reconstructed straight from the chain."
        />
      </div>

      <p className="mt-12 text-xs text-muted-foreground">
        Settlement infrastructure — not tax/legal advice, not a Merchant of Record. The delivery
        oracle is simulated via an admin action.
      </p>
    </div>
  )
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-foreground">
        {icon}
      </div>
      <h3 className="mt-3 font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  )
}
