import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import { AuthProvider } from './lib/auth';
import { CurrentCompanyProvider } from './lib/current-company';

/**
 * Last-resort boundary: any uncaught render error used to unmount the whole
 * tree and leave a bare white page with nothing to report. Now it shows the
 * actual error so a user (or a screenshot) can tell us what broke.
 */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50 p-6 text-center">
          <p className="text-base font-medium text-slate-900">Something went wrong.</p>
          <pre className="max-w-xl overflow-auto rounded-md border border-rose-200 bg-rose-50 p-3 text-left text-xs text-rose-700">
            {this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, err) => {
        const status = (err as { status?: number } | null)?.status;
        if (status && status >= 400 && status < 500) return false;
        return count < 2;
      },
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <CurrentCompanyProvider>
            <App />
          </CurrentCompanyProvider>
        </AuthProvider>
      </QueryClientProvider>
    </RootErrorBoundary>
  </React.StrictMode>,
);
