import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './lib/api';
import { useAuth } from './lib/auth';
import { AppShell } from './components/AppShell';
import { CreateCompany } from './components/CreateCompany';
import { SignIn } from './components/SignIn';
import { W9UploadPage } from './components/W9UploadPage';

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
  // The /w9-upload/<token> route is intentionally PUBLIC -- contractors
  // open it without an account to upload their W-9. Match it before any
  // auth gating so we don't bounce them through Sign In.
  const path = typeof window !== 'undefined' ? window.location.pathname : '';
  const w9Match = /^\/w9-upload\/([A-Za-z0-9_\-]+)\/?$/.exec(path);
  if (w9Match) {
    return <W9UploadPage token={w9Match[1]!} />;
  }

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
