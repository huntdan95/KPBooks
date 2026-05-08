import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './lib/api';
import { useAuth } from './lib/auth';
import { AppShell } from './components/AppShell';
import { CreateCompany } from './components/CreateCompany';
import { SignIn } from './components/SignIn';

interface MeResponse {
  user: {
    id: string;
    email: string;
    firebaseUid: string;
  };
  memberships: Array<{
    companyId: string;
    companyName: string;
    role: 'owner' | 'admin' | 'bookkeeper' | 'viewer';
  }>;
}

export function App() {
  const auth = useAuth();

  if (auth.loading) {
    return <Splash label="Starting up…" />;
  }
  if (!auth.user) {
    return <SignIn />;
  }
  return <AuthedApp />;
}

function AuthedApp() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/me'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
  });

  if (me.isLoading) return <Splash label="Loading account…" />;
  if (me.isError) {
    return (
      <Splash
        label={
          me.error instanceof Error
            ? `Could not load account: ${me.error.message}`
            : 'Could not load account.'
        }
      />
    );
  }
  if (!me.data) return <Splash label="No data." />;

  if (me.data.memberships.length === 0) {
    return <CreateCompany />;
  }
  return <AppShell memberships={me.data.memberships} />;
}

function Splash({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-600">
      {label}
    </div>
  );
}
