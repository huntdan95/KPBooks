import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api, getApiBase, getIdToken } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { Generate1099Modal } from './Generate1099Modal';
import { RequestW9Modal } from './RequestW9Modal';

type WorkerType = 'contractor' | 'employee' | 'not_a_worker' | 'subcontractor';
type PayBasis = 'hourly' | 'weekly' | 'biweekly' | 'monthly' | 'annually' | 'project';
type PaySchedule = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
type FilingStatus =
  | 'single'
  | 'married_jointly'
  | 'married_separately'
  | 'head_of_household'
  | 'qualifying_widow';
type DocumentType =
  | 'w9'
  | 'w4'
  | 'i9'
  | 'contract'
  | 'insurance'
  | 'workers_comp'
  | 'direct_deposit_auth'
  | 'other';

interface WorkerRow {
  id: string;
  displayName: string;
  companyName: string | null;
  title: string | null;
  workerType: WorkerType;
  is1099Vendor: boolean;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  hireDate: string | null;
  terminationDate: string | null;
  payRate: string | null;
  payRateBasis: PayBasis | null;
  isActive: boolean;
  lifetimePaid: string;
  yearPaid: string;
  hasW9: boolean;
  documentCount: number;
  licenseExpiration: string | null;
  insuranceGeneralLiabilityExpiration: string | null;
  insuranceWorkersCompExpiration: string | null;
  lienWaiverRequired: boolean;
}

interface WorkerListResp {
  workers: WorkerRow[];
  year: number;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype: string;
  isActive: boolean;
}

interface DocumentRow {
  id: string;
  documentType: DocumentType;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  uploadedByUserId: string | null;
  notes: string | null;
  createdAt: string;
}

interface PaymentRow {
  id: string;
  reference: string | null;
  paymentDate: string;
  amount: string;
  paymentMethod: string;
  status: string;
  memo: string | null;
}

interface OpenBillRow {
  id: string;
  billNumber: string | null;
  billDate: string;
  dueDate: string;
  status: string;
  total: string;
  balanceDue: string;
}

interface MailingAddress {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

interface WorkerDetail {
  id: string;
  companyId: string;
  displayName: string;
  companyName: string | null;
  title: string | null;
  accountNumber: string | null;
  email: string | null;
  phone: string | null;
  mailingAddress: MailingAddress | null;
  defaultTermsDays: number | null;
  is1099Vendor: boolean;
  taxId: string | null;
  workerType: WorkerType;
  hireDate: string | null;
  terminationDate: string | null;
  payRate: string | null;
  payRateBasis: PayBasis | null;
  defaultExpenseAccountId: string | null;
  defaultExpenseAccount: { id: string; code: string; name: string } | null;
  workersCompClass: string | null;
  notes: string | null;
  isActive: boolean;
  // Phase A payroll-tracking fields
  paySchedule: PaySchedule | null;
  w2FilingStatus: FilingStatus | null;
  w2Allowances: number | null;
  w2AdditionalWithholding: string | null;
  w2State: string | null;
  licenseNumber: string | null;
  licenseState: string | null;
  licenseExpiration: string | null;
  insuranceGeneralLiabilityCarrier: string | null;
  insuranceGeneralLiabilityPolicyNumber: string | null;
  insuranceGeneralLiabilityExpiration: string | null;
  insuranceWorkersCompCarrier: string | null;
  insuranceWorkersCompPolicyNumber: string | null;
  insuranceWorkersCompExpiration: string | null;
  lienWaiverRequired: boolean;
  documents: DocumentRow[];
  recentPayments: PaymentRow[];
  openBills: OpenBillRow[];
  yearTotalPaid: string;
  yearPaymentCount: number;
  year: number;
}

const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  w9: 'Form W-9',
  w4: 'Form W-4',
  i9: 'Form I-9',
  contract: 'Contract',
  insurance: 'Insurance certificate',
  workers_comp: 'Workers comp',
  direct_deposit_auth: 'Direct-deposit auth',
  other: 'Other document',
};

const DOCUMENT_TYPE_ORDER: DocumentType[] = [
  'w9',
  'w4',
  'i9',
  'contract',
  'insurance',
  'workers_comp',
  'direct_deposit_auth',
  'other',
];

const PAY_BASIS_LABEL: Record<PayBasis, string> = {
  hourly: '/hr',
  weekly: '/wk',
  biweekly: '/2wk',
  monthly: '/mo',
  annually: '/yr',
  project: '/project',
};

function formatUsd(s: string | null | undefined): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = String(s).split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatAddress(a: MailingAddress | null): string {
  if (!a) return '';
  const lines: string[] = [];
  if (a.street1) lines.push(a.street1);
  if (a.street2) lines.push(a.street2);
  const cityLine = [a.city, a.state, a.postalCode].filter(Boolean).join(', ');
  if (cityLine) lines.push(cityLine);
  if (a.country) lines.push(a.country);
  return lines.join(' · ');
}

export function Workers() {
  const { companyId } = useCurrentCompany();
  const [tab, setTab] = useState<'all' | 'contractor' | 'subcontractor' | 'employee'>('all');
  const [activeOnly, setActiveOnly] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const params = new URLSearchParams();
  if (tab !== 'all') params.set('workerType', tab);
  if (activeOnly) params.set('active', 'true');
  const qs = params.toString();

  const workersQ = useQuery({
    queryKey: ['workers', companyId, tab, activeOnly],
    enabled: Boolean(companyId),
    queryFn: () => api<WorkerListResp>(`/workers${qs ? `?${qs}` : ''}`, { companyId }),
  });

  if (detailId) {
    return (
      <WorkerDetailView
        vendorId={detailId}
        onBack={() => setDetailId(null)}
      />
    );
  }

  const workers = workersQ.data?.workers ?? [];
  const year = workersQ.data?.year ?? new Date().getUTCFullYear();
  const counts = {
    all: workers.length,
    contractor: workers.filter((w) => w.workerType === 'contractor').length,
    subcontractor: workers.filter((w) => w.workerType === 'subcontractor').length,
    employee: workers.filter((w) => w.workerType === 'employee').length,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Workers</h2>
          <p className="text-sm text-slate-500">
            Contractors and employees, with HR documents (W-9 / W-4 / I-9 / contracts) and a live
            link to 1099 prep. Workers are stored as vendors under the hood, so payments you record
            against a worker flow into A/P, the 1099 summary, and year-end reports automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddForm((v) => !v)}
          className="shrink-0 whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          {showAddForm ? 'Cancel' : '+ Add worker'}
        </button>
      </div>

      {showAddForm && (
        <AddWorkerForm
          onCreated={(id) => {
            setShowAddForm(false);
            setDetailId(id);
          }}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200">
        <div className="flex gap-1">
          {(
            [
              { id: 'all', label: 'All workers', count: counts.all },
              { id: 'contractor', label: '1099 Contractors', count: counts.contractor },
              { id: 'subcontractor', label: '1099 Subs', count: counts.subcontractor },
              { id: 'employee', label: 'Employees', count: counts.employee },
            ] as const
          ).map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={
                  'border-b-2 px-3 py-2 text-sm transition-colors -mb-px ' +
                  (active
                    ? 'border-slate-900 font-medium text-slate-900'
                    : 'border-transparent text-slate-500 hover:text-slate-800')
                }
              >
                {t.label}
                <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-mono text-slate-600">
                  {t.count}
                </span>
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Active only
        </label>
      </div>

      {workersQ.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {workersQ.isError && (
        <p className="text-sm text-rose-600">
          {workersQ.error instanceof Error ? workersQ.error.message : 'Failed to load workers.'}
        </p>
      )}

      {!workersQ.isLoading && workers.length === 0 && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          No {tab === 'all' ? 'workers' : `${tab}s`} yet. Click "+ Add worker" above.
        </p>
      )}

      {workers.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Type</th>
                <th className="px-4 py-2 text-left font-medium">Tax ID</th>
                <th className="px-4 py-2 text-left font-medium">W-9</th>
                <th className="px-4 py-2 text-right font-medium">Paid {year}</th>
                <th className="px-4 py-2 text-right font-medium">Lifetime</th>
                <th className="px-4 py-2 text-left font-medium">Hired</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {workers.map((w) => {
                const yearPaidNum = Number(w.yearPaid);
                const meets1099 =
                  (w.workerType === 'contractor' || w.workerType === 'subcontractor') &&
                  w.is1099Vendor &&
                  yearPaidNum >= 600;
                return (
                  <tr
                    key={w.id}
                    onClick={() => setDetailId(w.id)}
                    className={
                      'cursor-pointer hover:bg-slate-50 ' + (w.isActive ? '' : 'opacity-60')
                    }
                  >
                    <td className="px-4 py-2 text-slate-900">
                      <div className="font-medium">
                        {w.displayName}
                        {!w.isActive && (
                          <span className="ml-2 text-xs text-slate-500">(inactive)</span>
                        )}
                      </div>
                      {w.title && <div className="text-xs text-slate-500">{w.title}</div>}
                      {w.workerType === 'subcontractor' && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          <CompliancePill label="License" expiration={w.licenseExpiration} />
                          <CompliancePill label="GL" expiration={w.insuranceGeneralLiabilityExpiration} />
                          <CompliancePill label="WC" expiration={w.insuranceWorkersCompExpiration} />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <WorkerTypeBadge type={w.workerType} is1099={w.is1099Vendor} />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {w.taxId ? (
                        <span className="text-slate-700">{maskTaxId(w.taxId)}</span>
                      ) : w.workerType === 'contractor' || w.workerType === 'subcontractor' ? (
                        <span className="rounded-md bg-rose-50 px-2 py-0.5 text-rose-700 ring-1 ring-rose-200">
                          missing
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {w.hasW9 ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/20">
                          ✓ on file
                        </span>
                      ) : w.workerType === 'contractor' || w.workerType === 'subcontractor' ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-rose-200">
                          missing
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-900">
                      <div className="flex items-center justify-end gap-1.5">
                        {meets1099 && (
                          <span
                            title="Crosses $600 1099-NEC threshold"
                            className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 ring-1 ring-amber-600/20"
                          >
                            1099
                          </span>
                        )}
                        {formatUsd(w.yearPaid)}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-700">
                      {formatUsd(w.lifetimePaid)}
                    </td>
                    <td className="px-4 py-2 text-slate-600">
                      {w.hireDate ?? <span className="text-slate-400">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function maskTaxId(s: string): string {
  // Show last 4 digits only, e.g. "***-**-1234" or "**-***1234"
  const digits = s.replace(/\D/g, '');
  if (digits.length === 0) return s;
  const last4 = digits.slice(-4);
  if (digits.length === 9) {
    // Looks like SSN if 9 digits and we don't know format -- mask as ***-**-####
    if (s.includes('-') && s.length >= 10 && s[3] === '-' && s[6] === '-') {
      return `***-**-${last4}`;
    }
    return `**-*****${last4}`;
  }
  return `••${last4}`;
}

function WorkerTypeBadge({ type, is1099 }: { type: WorkerType; is1099: boolean }) {
  if (type === 'contractor') {
    return (
      <span className="inline-flex items-center rounded-md bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-violet-600/20">
        Contractor{is1099 ? ' · 1099' : ''}
      </span>
    );
  }
  if (type === 'subcontractor') {
    return (
      <span className="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-600/20">
        Subcontractor{is1099 ? ' · 1099' : ''}
      </span>
    );
  }
  if (type === 'employee') {
    return (
      <span className="inline-flex items-center rounded-md bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-sky-600/20">
        Employee
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
      Vendor
    </span>
  );
}

/**
 * Returns a color-coded compliance pill for an expiration date, or null if
 * the date is far enough in the future to not warrant a warning. Used in the
 * Workers list and detail card to surface license/insurance/WC status at a glance.
 */
function CompliancePill({
  label,
  expiration,
}: {
  label: string;
  expiration: string | null;
}) {
  if (!expiration) {
    return (
      <span className="inline-flex items-center rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-rose-700 ring-1 ring-rose-200">
        {label} missing
      </span>
    );
  }
  const exp = new Date(expiration + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysUntil = Math.floor((exp.getTime() - today.getTime()) / 86400000);
  if (daysUntil < 0) {
    return (
      <span className="inline-flex items-center rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-rose-700 ring-1 ring-rose-200">
        {label} expired
      </span>
    );
  }
  if (daysUntil <= 30) {
    return (
      <span className="inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-800 ring-1 ring-amber-600/20">
        {label} {daysUntil}d
      </span>
    );
  }
  return null;
}

// ---------------------------- Add new worker form -------------------------

interface AddDraft {
  workerType: 'contractor' | 'employee' | 'subcontractor';
  displayName: string;
  companyName: string;
  title: string;
  email: string;
  phone: string;
  taxId: string;
  hireDate: string;
  payRate: string;
  payRateBasis: PayBasis | '';
  paySchedule: PaySchedule | '';
  defaultExpenseAccountId: string;
  workersCompClass: string;
  street1: string;
  city: string;
  state: string;
  postalCode: string;
  notes: string;
  // Subcontractor compliance
  licenseNumber: string;
  licenseState: string;
  licenseExpiration: string;
  insuranceGeneralLiabilityCarrier: string;
  insuranceGeneralLiabilityPolicyNumber: string;
  insuranceGeneralLiabilityExpiration: string;
  insuranceWorkersCompCarrier: string;
  insuranceWorkersCompPolicyNumber: string;
  insuranceWorkersCompExpiration: string;
  lienWaiverRequired: boolean;
  // W-2 specific
  w2FilingStatus: FilingStatus | '';
  w2Allowances: string;
  w2AdditionalWithholding: string;
  w2State: string;
}

const emptyAddDraft = (): AddDraft => ({
  workerType: 'contractor',
  displayName: '',
  companyName: '',
  title: '',
  email: '',
  phone: '',
  taxId: '',
  hireDate: '',
  payRate: '',
  payRateBasis: '',
  paySchedule: '',
  defaultExpenseAccountId: '',
  workersCompClass: '',
  street1: '',
  city: '',
  state: '',
  postalCode: '',
  notes: '',
  licenseNumber: '',
  licenseState: '',
  licenseExpiration: '',
  insuranceGeneralLiabilityCarrier: '',
  insuranceGeneralLiabilityPolicyNumber: '',
  insuranceGeneralLiabilityExpiration: '',
  insuranceWorkersCompCarrier: '',
  insuranceWorkersCompPolicyNumber: '',
  insuranceWorkersCompExpiration: '',
  lienWaiverRequired: false,
  w2FilingStatus: '',
  w2Allowances: '',
  w2AdditionalWithholding: '',
  w2State: '',
});

function AddWorkerForm({ onCreated }: { onCreated: (vendorId: string) => void }) {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AddDraft>(emptyAddDraft);

  const accountsQ = useQuery({
    queryKey: ['accounts', companyId, 'workers-add'],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ accounts: Account[] }>('/ledger/accounts?active=true&type=expense', { companyId }),
  });

  const expenseAccounts = accountsQ.data?.accounts ?? [];

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        workerType: draft.workerType,
        displayName: draft.displayName.trim(),
      };
      if (draft.companyName.trim()) body.companyName = draft.companyName.trim();
      if (draft.title.trim()) body.title = draft.title.trim();
      if (draft.email.trim()) body.email = draft.email.trim();
      if (draft.phone.trim()) body.phone = draft.phone.trim();
      if (draft.taxId.trim()) body.taxId = draft.taxId.trim();
      if (draft.hireDate) body.hireDate = draft.hireDate;
      if (draft.payRate.trim()) body.payRate = draft.payRate.trim();
      if (draft.payRateBasis) body.payRateBasis = draft.payRateBasis;
      if (draft.paySchedule) body.paySchedule = draft.paySchedule;
      if (draft.defaultExpenseAccountId)
        body.defaultExpenseAccountId = draft.defaultExpenseAccountId;
      if (draft.workersCompClass.trim()) body.workersCompClass = draft.workersCompClass.trim();
      if (draft.notes.trim()) body.notes = draft.notes.trim();
      // Phase A payroll-tracking fields
      if (draft.workerType === 'employee') {
        if (draft.w2FilingStatus) body.w2FilingStatus = draft.w2FilingStatus;
        if (draft.w2Allowances.trim()) body.w2Allowances = Number(draft.w2Allowances);
        if (draft.w2AdditionalWithholding.trim())
          body.w2AdditionalWithholding = draft.w2AdditionalWithholding.trim();
        if (draft.w2State.trim()) body.w2State = draft.w2State.trim();
      }
      if (draft.workerType === 'subcontractor') {
        if (draft.licenseNumber.trim()) body.licenseNumber = draft.licenseNumber.trim();
        if (draft.licenseState.trim()) body.licenseState = draft.licenseState.trim();
        if (draft.licenseExpiration) body.licenseExpiration = draft.licenseExpiration;
        if (draft.insuranceGeneralLiabilityCarrier.trim())
          body.insuranceGeneralLiabilityCarrier = draft.insuranceGeneralLiabilityCarrier.trim();
        if (draft.insuranceGeneralLiabilityPolicyNumber.trim())
          body.insuranceGeneralLiabilityPolicyNumber =
            draft.insuranceGeneralLiabilityPolicyNumber.trim();
        if (draft.insuranceGeneralLiabilityExpiration)
          body.insuranceGeneralLiabilityExpiration = draft.insuranceGeneralLiabilityExpiration;
        if (draft.insuranceWorkersCompCarrier.trim())
          body.insuranceWorkersCompCarrier = draft.insuranceWorkersCompCarrier.trim();
        if (draft.insuranceWorkersCompPolicyNumber.trim())
          body.insuranceWorkersCompPolicyNumber = draft.insuranceWorkersCompPolicyNumber.trim();
        if (draft.insuranceWorkersCompExpiration)
          body.insuranceWorkersCompExpiration = draft.insuranceWorkersCompExpiration;
        body.lienWaiverRequired = draft.lienWaiverRequired;
      }
      const addr: Record<string, string> = {};
      if (draft.street1.trim()) addr.street1 = draft.street1.trim();
      if (draft.city.trim()) addr.city = draft.city.trim();
      if (draft.state.trim()) addr.state = draft.state.trim();
      if (draft.postalCode.trim()) addr.postalCode = draft.postalCode.trim();
      if (Object.keys(addr).length > 0) body.mailingAddress = addr;
      return api<{ vendorId: string }>('/workers', { method: 'POST', companyId, body });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['workers', companyId] });
      onCreated(data.vendorId);
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.displayName.trim() || mutation.isPending) return;
    mutation.mutate();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-md border border-slate-200 bg-white p-4"
    >
      <h3 className="text-sm font-medium text-slate-700">Add worker</h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Type" required>
          <select
            value={draft.workerType}
            onChange={(e) =>
              setDraft({
                ...draft,
                workerType: e.target.value as 'contractor' | 'employee' | 'subcontractor',
              })
            }
            className={inputClass}
          >
            <option value="contractor">1099 Contractor (individual)</option>
            <option value="subcontractor">1099 Subcontractor (company)</option>
            <option value="employee">Employee (W-2)</option>
          </select>
        </Field>
        <Field label="Display name" required>
          <input
            type="text"
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            placeholder="John Smith"
            maxLength={200}
            required
            autoFocus
            className={inputClass}
          />
        </Field>
        <Field label="Title / role">
          <input
            type="text"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Lead carpenter"
            maxLength={120}
            className={inputClass}
          />
        </Field>
        <Field label="Business name (DBA)">
          <input
            type="text"
            value={draft.companyName}
            onChange={(e) => setDraft({ ...draft, companyName: e.target.value })}
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <Field
          label={
            draft.workerType === 'contractor' || draft.workerType === 'subcontractor'
              ? 'Tax ID (SSN/EIN) *'
              : 'Tax ID (SSN/EIN)'
          }
          required={draft.workerType === 'contractor' || draft.workerType === 'subcontractor'}
        >
          <input
            type="text"
            value={draft.taxId}
            onChange={(e) => setDraft({ ...draft, taxId: e.target.value })}
            placeholder="123-45-6789 or 12-3456789"
            maxLength={40}
            required={draft.workerType === 'contractor' || draft.workerType === 'subcontractor'}
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label="Hire / start date">
          <input
            type="date"
            value={draft.hireDate}
            onChange={(e) => setDraft({ ...draft, hireDate: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            maxLength={200}
            className={inputClass}
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
        <Field label="Default expense account">
          <select
            value={draft.defaultExpenseAccountId}
            onChange={(e) => setDraft({ ...draft, defaultExpenseAccountId: e.target.value })}
            className={inputClass}
          >
            <option value="">No default</option>
            {expenseAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Pay rate (display only)">
          <div className="flex gap-1">
            <input
              type="text"
              inputMode="decimal"
              value={draft.payRate}
              onChange={(e) => setDraft({ ...draft, payRate: e.target.value })}
              placeholder="50.00"
              className={inputClass + ' font-mono'}
            />
            <select
              value={draft.payRateBasis}
              onChange={(e) =>
                setDraft({ ...draft, payRateBasis: e.target.value as PayBasis | '' })
              }
              className={inputClass + ' w-32'}
            >
              <option value="">basis…</option>
              <option value="hourly">per hour</option>
              <option value="weekly">per week</option>
              <option value="biweekly">bi-weekly</option>
              <option value="monthly">per month</option>
              <option value="annually">per year</option>
              <option value="project">per project</option>
            </select>
          </div>
        </Field>
        <Field label="Workers comp class">
          <input
            type="text"
            value={draft.workersCompClass}
            onChange={(e) => setDraft({ ...draft, workersCompClass: e.target.value })}
            placeholder="5403, 8810, etc."
            maxLength={60}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Mailing street">
          <input
            type="text"
            value={draft.street1}
            onChange={(e) => setDraft({ ...draft, street1: e.target.value })}
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <Field label="City">
          <input
            type="text"
            value={draft.city}
            onChange={(e) => setDraft({ ...draft, city: e.target.value })}
            maxLength={100}
            className={inputClass}
          />
        </Field>
        <Field label="State">
          <input
            type="text"
            value={draft.state}
            onChange={(e) => setDraft({ ...draft, state: e.target.value })}
            maxLength={60}
            className={inputClass}
          />
        </Field>
        <Field label="ZIP">
          <input
            type="text"
            value={draft.postalCode}
            onChange={(e) => setDraft({ ...draft, postalCode: e.target.value })}
            maxLength={20}
            className={inputClass}
          />
        </Field>
      </div>

      {draft.workerType === 'employee' && (
        <fieldset className="space-y-3 rounded-md border border-sky-200 bg-sky-50/40 p-3">
          <legend className="px-1.5 text-xs font-semibold uppercase tracking-wider text-sky-800">
            W-2 details (display only — KPBooks doesn't compute taxes)
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Filing status">
              <select
                value={draft.w2FilingStatus}
                onChange={(e) =>
                  setDraft({ ...draft, w2FilingStatus: e.target.value as FilingStatus | '' })
                }
                className={inputClass}
              >
                <option value="">—</option>
                <option value="single">Single</option>
                <option value="married_jointly">Married filing jointly</option>
                <option value="married_separately">Married filing separately</option>
                <option value="head_of_household">Head of household</option>
                <option value="qualifying_widow">Qualifying widow(er)</option>
              </select>
            </Field>
            <Field label="Allowances (legacy W-4)">
              <input
                type="number"
                min={0}
                max={99}
                value={draft.w2Allowances}
                onChange={(e) => setDraft({ ...draft, w2Allowances: e.target.value })}
                className={inputClass + ' font-mono'}
              />
            </Field>
            <Field label="Extra withholding ($/check)">
              <input
                type="text"
                inputMode="decimal"
                value={draft.w2AdditionalWithholding}
                onChange={(e) =>
                  setDraft({ ...draft, w2AdditionalWithholding: e.target.value })
                }
                placeholder="0.00"
                className={inputClass + ' font-mono'}
              />
            </Field>
            <Field label="State (for SIT)">
              <input
                type="text"
                value={draft.w2State}
                onChange={(e) => setDraft({ ...draft, w2State: e.target.value })}
                maxLength={60}
                placeholder="TX"
                className={inputClass}
              />
            </Field>
            <Field label="Pay schedule">
              <select
                value={draft.paySchedule}
                onChange={(e) =>
                  setDraft({ ...draft, paySchedule: e.target.value as PaySchedule | '' })
                }
                className={inputClass}
              >
                <option value="">—</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="semimonthly">Semi-monthly</option>
                <option value="monthly">Monthly</option>
              </select>
            </Field>
          </div>
        </fieldset>
      )}

      {draft.workerType === 'subcontractor' && (
        <fieldset className="space-y-3 rounded-md border border-amber-200 bg-amber-50/40 p-3">
          <legend className="px-1.5 text-xs font-semibold uppercase tracking-wider text-amber-800">
            Subcontractor compliance
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="License number">
              <input
                type="text"
                value={draft.licenseNumber}
                onChange={(e) => setDraft({ ...draft, licenseNumber: e.target.value })}
                maxLength={60}
                className={inputClass + ' font-mono'}
              />
            </Field>
            <Field label="License state">
              <input
                type="text"
                value={draft.licenseState}
                onChange={(e) => setDraft({ ...draft, licenseState: e.target.value })}
                maxLength={60}
                placeholder="TX"
                className={inputClass}
              />
            </Field>
            <Field label="License expiration">
              <input
                type="date"
                value={draft.licenseExpiration}
                onChange={(e) => setDraft({ ...draft, licenseExpiration: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="GL insurance carrier">
              <input
                type="text"
                value={draft.insuranceGeneralLiabilityCarrier}
                onChange={(e) =>
                  setDraft({ ...draft, insuranceGeneralLiabilityCarrier: e.target.value })
                }
                maxLength={120}
                className={inputClass}
              />
            </Field>
            <Field label="GL policy number">
              <input
                type="text"
                value={draft.insuranceGeneralLiabilityPolicyNumber}
                onChange={(e) =>
                  setDraft({ ...draft, insuranceGeneralLiabilityPolicyNumber: e.target.value })
                }
                maxLength={60}
                className={inputClass + ' font-mono'}
              />
            </Field>
            <Field label="GL expiration">
              <input
                type="date"
                value={draft.insuranceGeneralLiabilityExpiration}
                onChange={(e) =>
                  setDraft({ ...draft, insuranceGeneralLiabilityExpiration: e.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="WC insurance carrier">
              <input
                type="text"
                value={draft.insuranceWorkersCompCarrier}
                onChange={(e) =>
                  setDraft({ ...draft, insuranceWorkersCompCarrier: e.target.value })
                }
                maxLength={120}
                className={inputClass}
              />
            </Field>
            <Field label="WC policy number">
              <input
                type="text"
                value={draft.insuranceWorkersCompPolicyNumber}
                onChange={(e) =>
                  setDraft({ ...draft, insuranceWorkersCompPolicyNumber: e.target.value })
                }
                maxLength={60}
                className={inputClass + ' font-mono'}
              />
            </Field>
            <Field label="WC expiration">
              <input
                type="date"
                value={draft.insuranceWorkersCompExpiration}
                onChange={(e) =>
                  setDraft({ ...draft, insuranceWorkersCompExpiration: e.target.value })
                }
                className={inputClass}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={draft.lienWaiverRequired}
              onChange={(e) => setDraft({ ...draft, lienWaiverRequired: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300"
            />
            Require lien waiver on every payment to this sub
          </label>
        </fieldset>
      )}

      <Field label="Notes">
        <textarea
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          maxLength={2000}
          rows={2}
          className={inputClass}
        />
      </Field>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!draft.displayName.trim() || mutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {mutation.isPending ? 'Adding…' : 'Add worker'}
        </button>
        <p className="text-xs text-slate-500">
          1099 contractors and subcontractors are auto-flagged for year-end 1099 prep. SSN / EIN
          required for both so the form can be filed.
        </p>
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error)}
        </div>
      )}
    </form>
  );
}

// ---------------------------- Detail view ---------------------------------

function WorkerDetailView({
  vendorId,
  onBack,
}: {
  vendorId: string;
  onBack: () => void;
}) {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [show1099Modal, setShow1099Modal] = useState(false);
  const [showW9Request, setShowW9Request] = useState(false);

  const detailQ = useQuery({
    queryKey: ['worker', vendorId, companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<WorkerDetail>(`/workers/${vendorId}`, { companyId }),
  });

  const data = detailQ.data;
  const yearPaidNum = data ? Number(data.yearTotalPaid) : 0;
  const meets1099 =
    data &&
    (data.workerType === 'contractor' || data.workerType === 'subcontractor') &&
    data.is1099Vendor &&
    yearPaidNum >= 600;
  const has1099 = data?.documents.some((d) => d.documentType === 'w9');

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['worker', vendorId, companyId] });
    void queryClient.invalidateQueries({ queryKey: ['workers', companyId] });
  };

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
      >
        ← Back to workers
      </button>

      {detailQ.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {detailQ.isError && (
        <p className="text-sm text-rose-600">
          {detailQ.error instanceof Error ? detailQ.error.message : 'Failed to load worker.'}
        </p>
      )}

      {data && (
        <>
          {/* Header card */}
          <div className="rounded-md border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
                    {data.displayName}
                  </h2>
                  <WorkerTypeBadge type={data.workerType} is1099={data.is1099Vendor} />
                  {!data.isActive && (
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      Inactive
                    </span>
                  )}
                  {data.workerType === 'subcontractor' && (
                    <>
                      <CompliancePill label="License" expiration={data.licenseExpiration} />
                      <CompliancePill
                        label="GL"
                        expiration={data.insuranceGeneralLiabilityExpiration}
                      />
                      <CompliancePill
                        label="WC"
                        expiration={data.insuranceWorkersCompExpiration}
                      />
                    </>
                  )}
                </div>
                {data.title && <div className="text-sm text-slate-600">{data.title}</div>}
                {data.companyName && (
                  <div className="text-xs text-slate-500">DBA: {data.companyName}</div>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-xs text-slate-600">
                  {data.email && <span>📧 {data.email}</span>}
                  {data.phone && <span>📞 {data.phone}</span>}
                  {data.taxId && (
                    <span className="font-mono">TIN {maskTaxId(data.taxId)}</span>
                  )}
                  {data.hireDate && <span>Hired {data.hireDate}</span>}
                  {data.terminationDate && (
                    <span className="text-rose-600">Terminated {data.terminationDate}</span>
                  )}
                  {data.payRate && (
                    <span>
                      {formatUsd(data.payRate)}
                      {data.payRateBasis && PAY_BASIS_LABEL[data.payRateBasis]}
                    </span>
                  )}
                </div>
                {data.mailingAddress && formatAddress(data.mailingAddress) && (
                  <div className="text-xs text-slate-500">
                    📍 {formatAddress(data.mailingAddress)}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setEditing((v) => !v)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                {editing ? 'Cancel' : 'Edit'}
              </button>
            </div>
          </div>

          {editing && (
            <EditWorkerForm
              data={data}
              onSaved={() => {
                setEditing(false);
                invalidate();
              }}
            />
          )}

          {/* KPI tiles */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Stat
              label={`Paid in ${data.year}`}
              value={formatUsd(data.yearTotalPaid)}
              tone={meets1099 ? 'amber' : 'slate'}
              hint={
                meets1099
                  ? '1099-NEC required at year-end'
                  : data.workerType === 'contractor'
                    ? `${data.yearPaymentCount} payment(s)`
                    : `${data.yearPaymentCount} payment(s)`
              }
            />
            <Stat
              label="Lifetime payments"
              value={String(data.recentPayments.length === 50 ? '50+' : data.recentPayments.length)}
              tone="slate"
            />
            <Stat
              label="Open A/P"
              value={formatUsd(
                data.openBills.reduce((acc, b) => acc + Number(b.balanceDue), 0).toFixed(4),
              )}
              tone={data.openBills.length > 0 ? 'rose' : 'emerald'}
              hint={`${data.openBills.length} open bill(s)`}
            />
            <Stat
              label="W-9 status"
              value={has1099 ? '✓ on file' : 'missing'}
              tone={has1099 ? 'emerald' : data.workerType === 'contractor' ? 'rose' : 'slate'}
            />
          </div>

          {data.workerType === 'contractor' && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900">
              <div>
                💡 1099 connection: this contractor is included in the year-end{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    window.dispatchEvent(
                      new CustomEvent('kpb:navigate', { detail: '1099-prep' }),
                    );
                  }}
                  className="font-medium underline hover:text-violet-700"
                >
                  1099 prep summary
                </a>
                . Generate the printable form here.
              </div>
              <button
                type="button"
                onClick={() => setShow1099Modal(true)}
                className="shrink-0 rounded-md border border-violet-300 bg-white px-3 py-1.5 text-xs font-medium text-violet-800 hover:bg-violet-100"
              >
                Generate 1099-NEC
              </button>
            </div>
          )}

          {show1099Modal && (
            <Generate1099Modal vendorId={vendorId} onClose={() => setShow1099Modal(false)} />
          )}

          {/* Documents */}
          <section className="rounded-md border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
              <h3 className="text-sm font-semibold text-slate-900">
                Documents
                <span className="ml-2 text-xs font-normal text-slate-500">
                  {data.documents.length} on file
                </span>
              </h3>
              <div className="flex items-center gap-2">
                {data.workerType === 'contractor' && (
                  <button
                    type="button"
                    onClick={() => setShowW9Request(true)}
                    className="rounded-md border border-violet-300 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100"
                    title="Generate a single-use upload link for the contractor (no login)"
                  >
                    Request W-9 from contractor
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowUpload((v) => !v)}
                  className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100"
                >
                  {showUpload ? 'Cancel' : '+ Upload'}
                </button>
              </div>
            </div>

            {showW9Request && (
              <RequestW9Modal
                vendorId={vendorId}
                vendorName={data.displayName}
                companyName={null}
                onClose={() => setShowW9Request(false)}
              />
            )}
            {showUpload && (
              <div className="border-b border-slate-200 px-4 py-3">
                <UploadDocumentForm
                  vendorId={vendorId}
                  onUploaded={() => {
                    setShowUpload(false);
                    invalidate();
                  }}
                />
              </div>
            )}
            {data.documents.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-slate-500">
                No documents yet. Upload a W-9 above.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Type</th>
                    <th className="px-4 py-2 text-left font-medium">File</th>
                    <th className="px-4 py-2 text-right font-medium">Size</th>
                    <th className="px-4 py-2 text-left font-medium">Uploaded</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {[...data.documents]
                    .sort(
                      (a, b) =>
                        DOCUMENT_TYPE_ORDER.indexOf(a.documentType) -
                        DOCUMENT_TYPE_ORDER.indexOf(b.documentType),
                    )
                    .map((d) => (
                      <DocumentRowView
                        key={d.id}
                        vendorId={vendorId}
                        doc={d}
                        onChanged={invalidate}
                      />
                    ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Open bills */}
          {data.openBills.length > 0 && (
            <section className="overflow-hidden rounded-md border border-slate-200 bg-white">
              <h3 className="border-b border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-900">
                Open bills
              </h3>
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Bill #</th>
                    <th className="px-4 py-2 text-left font-medium">Date</th>
                    <th className="px-4 py-2 text-left font-medium">Due</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                    <th className="px-4 py-2 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {data.openBills.map((b) => (
                    <tr key={b.id}>
                      <td className="px-4 py-2 font-mono text-slate-700">{b.billNumber ?? '—'}</td>
                      <td className="px-4 py-2 text-slate-700">{b.billDate}</td>
                      <td className="px-4 py-2 text-slate-700">{b.dueDate}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{b.status}</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-700">
                        {formatUsd(b.total)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-slate-900">
                        {formatUsd(b.balanceDue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Recent payments */}
          <section className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <h3 className="border-b border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-900">
              Recent payments
              <span className="ml-2 text-xs font-normal text-slate-500">
                {data.recentPayments.length === 50 ? 'most recent 50' : data.recentPayments.length}
              </span>
            </h3>
            {data.recentPayments.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-slate-500">
                No payments recorded for this worker yet.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Date</th>
                    <th className="px-4 py-2 text-left font-medium">Reference</th>
                    <th className="px-4 py-2 text-left font-medium">Method</th>
                    <th className="px-4 py-2 text-left font-medium">Memo</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {data.recentPayments.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-2 text-slate-700">{p.paymentDate}</td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-600">
                        {p.reference ?? '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-500">{p.paymentMethod}</td>
                      <td className="px-4 py-2 text-slate-700">{p.memo ?? ''}</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-900">
                        {formatUsd(p.amount)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <PayStubLink paymentId={p.id} payDate={p.paymentDate} workerName={data.displayName} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ---------------------------- Document upload -----------------------------

function UploadDocumentForm({
  vendorId,
  onUploaded,
}: {
  vendorId: string;
  onUploaded: () => void;
}) {
  const { companyId } = useCurrentCompany();
  const [documentType, setDocumentType] = useState<DocumentType>('w9');
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError('Pick a file first.');
      return;
    }
    if (file.size === 0) {
      setError('File is empty.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError(`File too large (max 10 MB, got ${formatBytes(file.size)}).`);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const fileBase64 = await fileToBase64(file);
      const body: Record<string, unknown> = {
        documentType,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileBase64,
      };
      if (notes.trim()) body.notes = notes.trim();
      await api(`/workers/${vendorId}/documents`, {
        method: 'POST',
        companyId,
        body,
      });
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Document type" required>
          <select
            value={documentType}
            onChange={(e) => setDocumentType(e.target.value as DocumentType)}
            className={inputClass}
          >
            {DOCUMENT_TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {DOCUMENT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="File (PDF, image, max 10 MB)" required>
          <input
            type="file"
            accept="application/pdf,image/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
          />
        </Field>
      </div>
      <Field label="Notes (optional)">
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={500}
          placeholder="Signed 2026-01-15 etc."
          className={inputClass}
        />
      </Field>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!file || uploading}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
        {file && (
          <span className="text-xs text-slate-500">
            {file.name} · {formatBytes(file.size)}
          </span>
        )}
      </div>
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </div>
      )}
    </form>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to read file'));
        return;
      }
      // dataURL = "data:<mime>;base64,<payload>"
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Per-payment pay-stub download link in the Recent Payments table.
 * Same auth pattern as the worker-document download: build the URL and
 * fetch with a Bearer token + tenant header, then download the blob.
 */
function PayStubLink({
  paymentId,
  payDate,
  workerName,
}: {
  paymentId: string;
  payDate: string;
  workerName: string;
}) {
  const { companyId } = useCurrentCompany();
  const [busy, setBusy] = useState(false);

  async function downloadStub() {
    setBusy(true);
    try {
      const token = await getIdToken();
      const res = await fetch(`${getApiBase()}/payments/${paymentId}/pay-stub.pdf`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(companyId ? { 'x-kpbooks-company': companyId } : {}),
        },
      });
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
      a.download = `${workerName.replace(/[^A-Za-z0-9]+/g, '_')}_PayStub_${payDate}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={downloadStub}
      disabled={busy}
      className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
      title="Download a printable pay stub for this payment"
    >
      {busy ? '…' : 'Stub'}
    </button>
  );
}

function DocumentRowView({
  vendorId,
  doc,
  onChanged,
}: {
  vendorId: string;
  doc: DocumentRow;
  onChanged: () => void;
}) {
  const { companyId } = useCurrentCompany();
  const [busy, setBusy] = useState(false);

  async function downloadFile() {
    setBusy(true);
    try {
      const token = await getIdToken();
      const res = await fetch(
        `${getApiBase()}/workers/${vendorId}/documents/${doc.id}/download`,
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(companyId ? { 'x-kpbooks-company': companyId } : {}),
          },
        },
      );
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm(`Delete ${doc.fileName}?`)) return;
    setBusy(true);
    try {
      await api(`/workers/${vendorId}/documents/${doc.id}`, {
        method: 'DELETE',
        companyId,
      });
      onChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="px-4 py-2">
        <span
          className={
            'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
            (doc.documentType === 'w9'
              ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
              : doc.documentType === 'i9' || doc.documentType === 'w4'
                ? 'bg-sky-50 text-sky-700 ring-sky-600/20'
                : 'bg-slate-100 text-slate-700 ring-slate-300')
          }
        >
          {DOCUMENT_TYPE_LABEL[doc.documentType]}
        </span>
      </td>
      <td className="px-4 py-2 text-slate-900">
        <div>{doc.fileName}</div>
        {doc.notes && <div className="text-xs text-slate-500">{doc.notes}</div>}
      </td>
      <td className="px-4 py-2 text-right font-mono text-xs text-slate-600">
        {formatBytes(doc.fileSizeBytes)}
      </td>
      <td className="px-4 py-2 text-xs text-slate-600">
        {new Date(doc.createdAt).toLocaleDateString()}
      </td>
      <td className="px-4 py-2 text-right">
        <div className="flex justify-end gap-1">
          <button
            type="button"
            onClick={downloadFile}
            disabled={busy}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
          >
            Download
          </button>
          <button
            type="button"
            onClick={del}
            disabled={busy}
            className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------- Edit form -----------------------------------

function EditWorkerForm({
  data,
  onSaved,
}: {
  data: WorkerDetail;
  onSaved: () => void;
}) {
  const { companyId } = useCurrentCompany();
  const [draft, setDraft] = useState(() => ({
    displayName: data.displayName,
    companyName: data.companyName ?? '',
    title: data.title ?? '',
    email: data.email ?? '',
    phone: data.phone ?? '',
    taxId: data.taxId ?? '',
    workerType: data.workerType,
    is1099Vendor: data.is1099Vendor,
    hireDate: data.hireDate ?? '',
    terminationDate: data.terminationDate ?? '',
    payRate: data.payRate ?? '',
    payRateBasis: data.payRateBasis ?? ('' as PayBasis | ''),
    defaultExpenseAccountId: data.defaultExpenseAccountId ?? '',
    workersCompClass: data.workersCompClass ?? '',
    notes: data.notes ?? '',
    isActive: data.isActive,
    street1: data.mailingAddress?.street1 ?? '',
    street2: data.mailingAddress?.street2 ?? '',
    city: data.mailingAddress?.city ?? '',
    state: data.mailingAddress?.state ?? '',
    postalCode: data.mailingAddress?.postalCode ?? '',
    paySchedule: data.paySchedule ?? ('' as PaySchedule | ''),
    w2FilingStatus: data.w2FilingStatus ?? ('' as FilingStatus | ''),
    w2Allowances: data.w2Allowances != null ? String(data.w2Allowances) : '',
    w2AdditionalWithholding: data.w2AdditionalWithholding ?? '',
    w2State: data.w2State ?? '',
    licenseNumber: data.licenseNumber ?? '',
    licenseState: data.licenseState ?? '',
    licenseExpiration: data.licenseExpiration ?? '',
    insuranceGeneralLiabilityCarrier: data.insuranceGeneralLiabilityCarrier ?? '',
    insuranceGeneralLiabilityPolicyNumber: data.insuranceGeneralLiabilityPolicyNumber ?? '',
    insuranceGeneralLiabilityExpiration: data.insuranceGeneralLiabilityExpiration ?? '',
    insuranceWorkersCompCarrier: data.insuranceWorkersCompCarrier ?? '',
    insuranceWorkersCompPolicyNumber: data.insuranceWorkersCompPolicyNumber ?? '',
    insuranceWorkersCompExpiration: data.insuranceWorkersCompExpiration ?? '',
    lienWaiverRequired: data.lienWaiverRequired,
  }));

  const accountsQ = useQuery({
    queryKey: ['accounts', companyId, 'workers-edit'],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ accounts: Account[] }>('/ledger/accounts?active=true&type=expense', { companyId }),
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        displayName: draft.displayName.trim(),
        workerType: draft.workerType,
        is1099Vendor: draft.is1099Vendor,
        isActive: draft.isActive,
      };
      const norm = (v: string) => (v.trim() ? v.trim() : null);
      body.companyName = norm(draft.companyName);
      body.title = norm(draft.title);
      body.email = norm(draft.email);
      body.phone = norm(draft.phone);
      body.taxId = norm(draft.taxId);
      body.hireDate = draft.hireDate || null;
      body.terminationDate = draft.terminationDate || null;
      body.payRate = draft.payRate.trim() || null;
      body.payRateBasis = draft.payRateBasis || null;
      body.defaultExpenseAccountId = draft.defaultExpenseAccountId || null;
      body.workersCompClass = norm(draft.workersCompClass);
      body.notes = norm(draft.notes);
      const addr: Record<string, string> = {};
      if (draft.street1.trim()) addr.street1 = draft.street1.trim();
      if (draft.street2.trim()) addr.street2 = draft.street2.trim();
      if (draft.city.trim()) addr.city = draft.city.trim();
      if (draft.state.trim()) addr.state = draft.state.trim();
      if (draft.postalCode.trim()) addr.postalCode = draft.postalCode.trim();
      body.mailingAddress = Object.keys(addr).length > 0 ? addr : null;
      // Phase A payroll-tracking fields (always send so unsetting a value works)
      body.paySchedule = draft.paySchedule || null;
      body.w2FilingStatus = draft.w2FilingStatus || null;
      body.w2Allowances = draft.w2Allowances.trim() ? Number(draft.w2Allowances) : null;
      body.w2AdditionalWithholding = draft.w2AdditionalWithholding.trim() || null;
      body.w2State = norm(draft.w2State);
      body.licenseNumber = norm(draft.licenseNumber);
      body.licenseState = norm(draft.licenseState);
      body.licenseExpiration = draft.licenseExpiration || null;
      body.insuranceGeneralLiabilityCarrier = norm(draft.insuranceGeneralLiabilityCarrier);
      body.insuranceGeneralLiabilityPolicyNumber = norm(
        draft.insuranceGeneralLiabilityPolicyNumber,
      );
      body.insuranceGeneralLiabilityExpiration = draft.insuranceGeneralLiabilityExpiration || null;
      body.insuranceWorkersCompCarrier = norm(draft.insuranceWorkersCompCarrier);
      body.insuranceWorkersCompPolicyNumber = norm(draft.insuranceWorkersCompPolicyNumber);
      body.insuranceWorkersCompExpiration = draft.insuranceWorkersCompExpiration || null;
      body.lienWaiverRequired = draft.lienWaiverRequired;

      return api(`/workers/${data.id}`, { method: 'PATCH', companyId, body });
    },
    onSuccess: onSaved,
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.displayName.trim() || mutation.isPending) return;
    mutation.mutate();
  }

  const expenseAccounts = accountsQ.data?.accounts ?? [];

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-md border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-medium text-slate-700">Edit worker</h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Display name" required>
          <input
            type="text"
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            required
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <Field label="Type">
          <select
            value={draft.workerType}
            onChange={(e) => setDraft({ ...draft, workerType: e.target.value as WorkerType })}
            className={inputClass}
          >
            <option value="contractor">1099 Contractor (individual)</option>
            <option value="subcontractor">1099 Subcontractor (company)</option>
            <option value="employee">Employee (W-2)</option>
            <option value="not_a_worker">Not a worker (regular vendor)</option>
          </select>
        </Field>
        <Field label="Title / role">
          <input
            type="text"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            maxLength={120}
            className={inputClass}
          />
        </Field>
        <Field label="Business name (DBA)">
          <input
            type="text"
            value={draft.companyName}
            onChange={(e) => setDraft({ ...draft, companyName: e.target.value })}
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <Field label="Tax ID (SSN/EIN)">
          <input
            type="text"
            value={draft.taxId}
            onChange={(e) => setDraft({ ...draft, taxId: e.target.value })}
            maxLength={40}
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            maxLength={200}
            className={inputClass}
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
        <Field label="Hire date">
          <input
            type="date"
            value={draft.hireDate}
            onChange={(e) => setDraft({ ...draft, hireDate: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label="Termination date">
          <input
            type="date"
            value={draft.terminationDate}
            onChange={(e) => setDraft({ ...draft, terminationDate: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label="Default expense account">
          <select
            value={draft.defaultExpenseAccountId}
            onChange={(e) => setDraft({ ...draft, defaultExpenseAccountId: e.target.value })}
            className={inputClass}
          >
            <option value="">No default</option>
            {expenseAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Pay rate">
          <div className="flex gap-1">
            <input
              type="text"
              inputMode="decimal"
              value={draft.payRate}
              onChange={(e) => setDraft({ ...draft, payRate: e.target.value })}
              className={inputClass + ' font-mono'}
            />
            <select
              value={draft.payRateBasis}
              onChange={(e) =>
                setDraft({ ...draft, payRateBasis: e.target.value as PayBasis | '' })
              }
              className={inputClass + ' w-32'}
            >
              <option value="">basis…</option>
              <option value="hourly">per hour</option>
              <option value="weekly">per week</option>
              <option value="biweekly">bi-weekly</option>
              <option value="monthly">per month</option>
              <option value="annually">per year</option>
              <option value="project">per project</option>
            </select>
          </div>
        </Field>
        <Field label="Workers comp class">
          <input
            type="text"
            value={draft.workersCompClass}
            onChange={(e) => setDraft({ ...draft, workersCompClass: e.target.value })}
            maxLength={60}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Street">
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
        <Field label="City">
          <input
            type="text"
            value={draft.city}
            onChange={(e) => setDraft({ ...draft, city: e.target.value })}
            maxLength={100}
            className={inputClass}
          />
        </Field>
        <Field label="State">
          <input
            type="text"
            value={draft.state}
            onChange={(e) => setDraft({ ...draft, state: e.target.value })}
            maxLength={60}
            className={inputClass}
          />
        </Field>
        <Field label="ZIP">
          <input
            type="text"
            value={draft.postalCode}
            onChange={(e) => setDraft({ ...draft, postalCode: e.target.value })}
            maxLength={20}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={draft.is1099Vendor}
            onChange={(e) => setDraft({ ...draft, is1099Vendor: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300"
          />
          Issue 1099-NEC at year-end
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={draft.isActive}
            onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300"
          />
          Active
        </label>
      </div>

      {draft.workerType === 'employee' && (
        <fieldset className="space-y-3 rounded-md border border-sky-200 bg-sky-50/40 p-3">
          <legend className="px-1.5 text-xs font-semibold uppercase tracking-wider text-sky-800">
            W-2 details (display only)
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Filing status">
              <select
                value={draft.w2FilingStatus}
                onChange={(e) =>
                  setDraft({ ...draft, w2FilingStatus: e.target.value as FilingStatus | '' })
                }
                className={inputClass}
              >
                <option value="">—</option>
                <option value="single">Single</option>
                <option value="married_jointly">MFJ</option>
                <option value="married_separately">MFS</option>
                <option value="head_of_household">HoH</option>
                <option value="qualifying_widow">QW</option>
              </select>
            </Field>
            <Field label="Allowances">
              <input
                type="number"
                min={0}
                max={99}
                value={draft.w2Allowances}
                onChange={(e) => setDraft({ ...draft, w2Allowances: e.target.value })}
                className={inputClass + ' font-mono'}
              />
            </Field>
            <Field label="Extra withholding ($/check)">
              <input
                type="text"
                inputMode="decimal"
                value={draft.w2AdditionalWithholding}
                onChange={(e) =>
                  setDraft({ ...draft, w2AdditionalWithholding: e.target.value })
                }
                className={inputClass + ' font-mono'}
              />
            </Field>
            <Field label="State">
              <input
                type="text"
                value={draft.w2State}
                onChange={(e) => setDraft({ ...draft, w2State: e.target.value })}
                maxLength={60}
                className={inputClass}
              />
            </Field>
            <Field label="Pay schedule">
              <select
                value={draft.paySchedule}
                onChange={(e) =>
                  setDraft({ ...draft, paySchedule: e.target.value as PaySchedule | '' })
                }
                className={inputClass}
              >
                <option value="">—</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="semimonthly">Semi-monthly</option>
                <option value="monthly">Monthly</option>
              </select>
            </Field>
          </div>
        </fieldset>
      )}

      {draft.workerType === 'subcontractor' && (
        <fieldset className="space-y-3 rounded-md border border-amber-200 bg-amber-50/40 p-3">
          <legend className="px-1.5 text-xs font-semibold uppercase tracking-wider text-amber-800">
            Subcontractor compliance
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="License number">
              <input
                type="text"
                value={draft.licenseNumber}
                onChange={(e) => setDraft({ ...draft, licenseNumber: e.target.value })}
                maxLength={60}
                className={inputClass + ' font-mono'}
              />
            </Field>
            <Field label="License state">
              <input
                type="text"
                value={draft.licenseState}
                onChange={(e) => setDraft({ ...draft, licenseState: e.target.value })}
                maxLength={60}
                className={inputClass}
              />
            </Field>
            <Field label="License expiration">
              <input
                type="date"
                value={draft.licenseExpiration}
                onChange={(e) => setDraft({ ...draft, licenseExpiration: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="GL insurance carrier">
              <input
                type="text"
                value={draft.insuranceGeneralLiabilityCarrier}
                onChange={(e) =>
                  setDraft({ ...draft, insuranceGeneralLiabilityCarrier: e.target.value })
                }
                maxLength={120}
                className={inputClass}
              />
            </Field>
            <Field label="GL policy number">
              <input
                type="text"
                value={draft.insuranceGeneralLiabilityPolicyNumber}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    insuranceGeneralLiabilityPolicyNumber: e.target.value,
                  })
                }
                maxLength={60}
                className={inputClass + ' font-mono'}
              />
            </Field>
            <Field label="GL expiration">
              <input
                type="date"
                value={draft.insuranceGeneralLiabilityExpiration}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    insuranceGeneralLiabilityExpiration: e.target.value,
                  })
                }
                className={inputClass}
              />
            </Field>
            <Field label="WC insurance carrier">
              <input
                type="text"
                value={draft.insuranceWorkersCompCarrier}
                onChange={(e) =>
                  setDraft({ ...draft, insuranceWorkersCompCarrier: e.target.value })
                }
                maxLength={120}
                className={inputClass}
              />
            </Field>
            <Field label="WC policy number">
              <input
                type="text"
                value={draft.insuranceWorkersCompPolicyNumber}
                onChange={(e) =>
                  setDraft({ ...draft, insuranceWorkersCompPolicyNumber: e.target.value })
                }
                maxLength={60}
                className={inputClass + ' font-mono'}
              />
            </Field>
            <Field label="WC expiration">
              <input
                type="date"
                value={draft.insuranceWorkersCompExpiration}
                onChange={(e) =>
                  setDraft({ ...draft, insuranceWorkersCompExpiration: e.target.value })
                }
                className={inputClass}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={draft.lienWaiverRequired}
              onChange={(e) => setDraft({ ...draft, lienWaiverRequired: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300"
            />
            Require lien waiver on every payment to this sub
          </label>
        </fieldset>
      )}

      <Field label="Notes">
        <textarea
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          maxLength={2000}
          rows={2}
          className={inputClass}
        />
      </Field>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!draft.displayName.trim() || mutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {mutation.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error)}
        </div>
      )}
    </form>
  );
}

// ---------------------------- Bits -----------------------------------------

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'rose' | 'slate' | 'amber';
  hint?: string;
}) {
  const toneClass = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
    slate: 'border-slate-200 bg-white text-slate-900',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
  }[tone];
  return (
    <div className={'rounded-md border p-3 ' + toneClass}>
      <div className="text-xs uppercase tracking-wider opacity-70">{label}</div>
      <div className="mt-1 font-mono text-xl">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] opacity-70">{hint}</div>}
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
