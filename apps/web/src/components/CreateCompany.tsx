import { signOut } from '../lib/firebase';
import { NewCompanyForm } from './NewCompanyForm';

/**
 * Splash form shown to a freshly-signed-in user with zero memberships.
 * Wraps the shared NewCompanyForm with a centred panel + a sign-out
 * escape hatch.
 */
export function CreateCompany() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md space-y-5 rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            Create your first client
          </h1>
          <p className="text-sm text-slate-600">
            Each client (a small business you serve) gets their own chart of accounts, customers,
            vendors, and reports — fully isolated.
          </p>
        </div>
        <NewCompanyForm />
        <button
          type="button"
          onClick={() => void signOut()}
          className="w-full text-xs text-slate-500 hover:text-slate-700"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
