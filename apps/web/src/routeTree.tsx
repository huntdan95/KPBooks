import { Outlet, createRootRouteWithContext, createRoute } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight">KPBooks</h1>
      </header>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeView,
});

function HomeView() {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <p className="text-sm text-slate-600">
        Phase 0 scaffold. Sign-in, company switcher, and ledger views land next.
      </p>
      <ul className="list-disc pl-5 text-sm text-slate-700">
        <li>Cloud SQL ledger with deferred balance trigger</li>
        <li>Firebase Auth + RLS-scoped tenant transactions</li>
        <li>Trial balance / P&amp;L / Balance sheet endpoints live</li>
      </ul>
    </div>
  );
}

export const routeTree = rootRoute.addChildren([indexRoute]);
