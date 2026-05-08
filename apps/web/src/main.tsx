import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import { AuthProvider } from './lib/auth';
import { CurrentCompanyProvider } from './lib/current-company';

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
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <CurrentCompanyProvider>
          <App />
        </CurrentCompanyProvider>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
