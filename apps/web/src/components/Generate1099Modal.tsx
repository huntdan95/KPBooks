import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api, getApiBase, getIdToken } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type CopyType = 'B' | 'C' | 'all';

type FixHint =
  | 'company-settings'
  | 'worker-edit'
  | 'upload-w9'
  | 'pay-more';

interface PreflightIssue {
  field: string;
  message: string;
  fix: FixHint;
}

interface Address {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

interface PreflightResp {
  year: number;
  vendorId: string;
  issues: PreflightIssue[];
  nonemployeeCompensation: string;
  payer: {
    name: string;
    legalName: string | null;
    ein: string | null;
    address: Address | null;
    phone: string | null;
  };
  recipient: {
    displayName: string;
    taxId: string | null;
    address: Address | null;
    accountNumber: string | null;
  };
  hasW9: boolean;
}

const FIX_LABEL: Record<FixHint, string> = {
  'company-settings': 'Company info',
  'worker-edit': 'Worker info',
  'upload-w9': 'W-9 upload',
  'pay-more': 'Threshold',
};

const FIX_TONE: Record<FixHint, 'rose' | 'amber'> = {
  'company-settings': 'rose',
  'worker-edit': 'rose',
  'upload-w9': 'amber',
  'pay-more': 'amber',
};

function currentYear(): number {
  return new Date().getUTCFullYear();
}

function formatUsd(s: string | null | undefined): string {
  if (!s) return '$0.00';
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

export function Generate1099Modal({
  vendorId,
  initialYear,
  onClose,
}: {
  vendorId: string;
  initialYear?: number;
  onClose: () => void;
}) {
  const { companyId } = useCurrentCompany();
  const [year, setYear] = useState<number>(initialYear ?? currentYear() - 1);
  const [copy, setCopy] = useState<CopyType>('all');
  const [downloading, setDownloading] = useState(false);
  const [editingCompany, setEditingCompany] = useState(false);

  const preflightQ = useQuery({
    queryKey: ['1099-preflight', companyId, vendorId, year],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<PreflightResp>(`/workers/${vendorId}/1099-nec/preflight?year=${year}`, {
        companyId,
      }),
  });

  const data = preflightQ.data;
  const blockerCount =
    data?.issues.filter((i) => i.fix === 'company-settings' || i.fix === 'worker-edit').length ?? 0;
  const warningCount = (data?.issues.length ?? 0) - blockerCount;
  const canGenerate = !!data && blockerCount === 0;

  async function downloadPdf() {
    if (!data) return;
    setDownloading(true);
    try {
      const token = await getIdToken();
      const res = await fetch(
        `${getApiBase()}/workers/${vendorId}/1099-nec.pdf?year=${year}&copy=${copy}`,
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(companyId ? { 'x-kpbooks-company': companyId } : {}),
          },
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (body && typeof body === 'object' && 'message' in body
            ? String((body as { message?: string }).message)
            : '') || `HTTP ${res.status}`,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = `${data.recipient.displayName.replace(/[^A-Za-z0-9]+/g, '_')}_1099-NEC_${year}_Copy${copy}.pdf`;
      a.download = safeName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="my-8 w-full max-w-2xl space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              Generate Form 1099-NEC
            </h2>
            <p className="text-xs text-slate-500">
              Nonemployee Compensation. Generates Copies B (recipient) and C (payer) as a clean
              facsimile. Copy A must still be e-filed via FIRE or printed onto the official IRS
              red-ink scannable form.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Tax year">
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className={inputClass}
            >
              {Array.from({ length: 7 }, (_, i) => currentYear() - i).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Copy">
            <select
              value={copy}
              onChange={(e) => setCopy(e.target.value as CopyType)}
              className={inputClass}
            >
              <option value="all">B + C (recommended)</option>
              <option value="B">B — Recipient only</option>
              <option value="C">C — Payer only</option>
            </select>
          </Field>
        </div>

        {preflightQ.isLoading && <p className="text-sm text-slate-500">Checking…</p>}
        {preflightQ.isError && (
          <p className="text-sm text-rose-600">
            {preflightQ.error instanceof Error
              ? preflightQ.error.message
              : 'Failed to check pre-flight.'}
          </p>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <SummaryCard
                label={`Paid in ${year}`}
                value={formatUsd(data.nonemployeeCompensation)}
                tone={Number(data.nonemployeeCompensation) >= 600 ? 'emerald' : 'amber'}
              />
              <SummaryCard
                label="W-9 on file"
                value={data.hasW9 ? '✓ yes' : '✗ no'}
                tone={data.hasW9 ? 'emerald' : 'amber'}
              />
            </div>

            {data.issues.length === 0 ? (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                ✓ All checks passed — ready to generate.
              </div>
            ) : (
              <div className="space-y-2">
                {data.issues.map((issue, i) => (
                  <div
                    key={i}
                    className={
                      'rounded-md border px-3 py-2 text-sm ' +
                      (FIX_TONE[issue.fix] === 'rose'
                        ? 'border-rose-200 bg-rose-50 text-rose-800'
                        : 'border-amber-200 bg-amber-50 text-amber-800')
                    }
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <span className="font-medium">{FIX_LABEL[issue.fix]}:</span>{' '}
                        {issue.message}
                      </div>
                      {issue.fix === 'company-settings' && (
                        <button
                          type="button"
                          onClick={() => setEditingCompany(true)}
                          className="shrink-0 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-100"
                        >
                          Fix here
                        </button>
                      )}
                      {issue.fix === 'worker-edit' && (
                        <span className="shrink-0 text-xs italic">edit on Worker page</span>
                      )}
                      {issue.fix === 'upload-w9' && (
                        <span className="shrink-0 text-xs italic">
                          upload from Worker page
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {editingCompany && (
              <CompanySettingsInlineForm
                onClose={() => setEditingCompany(false)}
                onSaved={() => {
                  setEditingCompany(false);
                  void preflightQ.refetch();
                }}
              />
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                Close
              </button>
              <button
                type="button"
                onClick={downloadPdf}
                disabled={!canGenerate || downloading}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                title={
                  blockerCount > 0
                    ? `Fix ${blockerCount} blocker(s) above first`
                    : warningCount > 0
                      ? 'Has warnings but will still generate'
                      : 'Generate the PDF'
                }
              >
                {downloading
                  ? 'Generating…'
                  : warningCount > 0 && blockerCount === 0
                    ? `Generate anyway (${warningCount} warning${warningCount === 1 ? '' : 's'})`
                    : 'Generate PDF'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface CompanyCurrent {
  id: string;
  name: string;
  legalName: string | null;
  ein: string | null;
  address: Address | null;
  phone: string | null;
}

function CompanySettingsInlineForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();

  const companyQ = useQuery({
    queryKey: ['company-current', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<CompanyCurrent>('/companies/current', { companyId }),
  });

  const data = companyQ.data;
  const [draft, setDraft] = useState<{
    legalName: string;
    ein: string;
    phone: string;
    street1: string;
    street2: string;
    city: string;
    state: string;
    postalCode: string;
  } | null>(null);

  // Initialize draft from data when it arrives.
  if (data && draft === null) {
    setDraft({
      legalName: data.legalName ?? '',
      ein: data.ein ?? '',
      phone: data.phone ?? '',
      street1: data.address?.street1 ?? '',
      street2: data.address?.street2 ?? '',
      city: data.address?.city ?? '',
      state: data.address?.state ?? '',
      postalCode: data.address?.postalCode ?? '',
    });
  }

  const mutation = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      const addr: Record<string, string> = {};
      if (draft.street1.trim()) addr.street1 = draft.street1.trim();
      if (draft.street2.trim()) addr.street2 = draft.street2.trim();
      if (draft.city.trim()) addr.city = draft.city.trim();
      if (draft.state.trim()) addr.state = draft.state.trim();
      if (draft.postalCode.trim()) addr.postalCode = draft.postalCode.trim();
      const body: Record<string, unknown> = {
        legalName: draft.legalName.trim() || null,
        ein: draft.ein.trim() || null,
        phone: draft.phone.trim() || null,
        address: Object.keys(addr).length > 0 ? addr : null,
      };
      return api('/companies/current', { method: 'PATCH', companyId, body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['company-current', companyId] });
      onSaved();
    },
  });

  if (!data || !draft) {
    return <div className="text-sm text-slate-500">Loading company info…</div>;
  }

  return (
    <div className="space-y-3 rounded-md border border-slate-300 bg-slate-50 p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-900">Edit company info (used as Payer)</h4>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-500 underline hover:text-slate-700"
        >
          cancel
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Editing <strong>{data.name}</strong> — these fields print on the 1099 Payer block.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Legal name (optional)">
          <input
            type="text"
            value={draft.legalName}
            onChange={(e) => setDraft({ ...draft, legalName: e.target.value })}
            maxLength={160}
            className={inputClass}
          />
        </Field>
        <Field label="EIN" required>
          <input
            type="text"
            value={draft.ein}
            onChange={(e) => setDraft({ ...draft, ein: e.target.value })}
            placeholder="12-3456789"
            maxLength={20}
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label="Phone">
          <input
            type="tel"
            value={draft.phone}
            onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            maxLength={40}
            className={inputClass}
          />
        </Field>
        <Field label="Street" required>
          <input
            type="text"
            value={draft.street1}
            onChange={(e) => setDraft({ ...draft, street1: e.target.value })}
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <Field label="Street 2">
          <input
            type="text"
            value={draft.street2}
            onChange={(e) => setDraft({ ...draft, street2: e.target.value })}
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <Field label="City" required>
          <input
            type="text"
            value={draft.city}
            onChange={(e) => setDraft({ ...draft, city: e.target.value })}
            maxLength={100}
            className={inputClass}
          />
        </Field>
        <Field label="State" required>
          <input
            type="text"
            value={draft.state}
            onChange={(e) => setDraft({ ...draft, state: e.target.value })}
            maxLength={60}
            className={inputClass}
          />
        </Field>
        <Field label="ZIP" required>
          <input
            type="text"
            value={draft.postalCode}
            onChange={(e) => setDraft({ ...draft, postalCode: e.target.value })}
            maxLength={20}
            className={inputClass}
          />
        </Field>
      </div>
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {mutation.isPending ? 'Saving…' : 'Save & re-check'}
      </button>
      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error)}
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'amber';
}) {
  const cls =
    tone === 'emerald'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : 'border-amber-200 bg-amber-50 text-amber-700';
  return (
    <div className={'rounded-md border p-3 ' + cls}>
      <div className="text-xs uppercase tracking-wider opacity-70">{label}</div>
      <div className="mt-1 font-mono text-lg">{value}</div>
    </div>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : 'Failed.';
}

const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900';

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-rose-600">*</span>}
      </span>
      {children}
    </label>
  );
}
