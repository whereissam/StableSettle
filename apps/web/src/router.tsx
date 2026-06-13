import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import { Layout } from '@/components/layout'
import { LandingPage } from '@/routes/landing'
import { DashboardPage } from '@/routes/dashboard'
import { OrderDetailPage } from '@/routes/order-detail'
import { DemoPage } from '@/routes/demo'
import { AgentsPage } from '@/routes/agents'

const rootRoute = createRootRoute({
  component: () => (
    <Layout>
      <Outlet />
    </Layout>
  ),
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LandingPage,
})

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dashboard',
  component: DashboardPage,
})

const orderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/orders/$orderId',
  component: OrderDetailPage,
})

const demoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/demo',
  component: DemoPage,
})

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents',
  component: AgentsPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  dashboardRoute,
  orderRoute,
  demoRoute,
  agentsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
