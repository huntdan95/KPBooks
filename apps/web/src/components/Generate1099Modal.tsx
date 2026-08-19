import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ApiError, api, getApiBase, getIdToken } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type CopyType = 'B' | 'C' | 'all';
type FormType = 'nec' | 'misc';

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

interface PayerInfo {
  name: string;
  legalName: string | null;
  ein: string | null;
  address: Address | null;
  phone: string | null;
}

interface RecipientInfo {
  displayName: string;
  taxId: string | null;
  address: Address | null;
  accountNumber: string | null;
}

interface NecPreflightResp {
  year: number;
  vendorId: string;
  issues: PreflightIssue[];
  nonemployeeCompensation: string;
  payer: PayerInfo;
  recipient: RecipientInfo;
  hasW9: boolean;
}

// MISC supports many income boxes; only the commonly-used ones are exposed in
// the modal's primary form. Advanced boxes (state/FATCA/etc.) round-trip via
// the route but stay hidden in v1.
interface MiscBoxes {
  rents: string;
  royalties: string;
  otherIncome: string;
  federalIncomeTaxWithheld: string;
  medicalPayments: string;
  substitutePayments: string;
  attorneyProceeds: string;
}

interface MiscPreflightResp {
  year: number;
  vendorId: string;
  issues: PreflightIssue[];
  yearTotal: string;
  boxes: Partial<MiscBoxes>;
  defaultedToRents: boolean;
  payer: PayerInfo;
  recipient: RecipientInfo;
  hasW9: boolean;
}

const EMPTY_MISC_BOXES: MiscBoxes = {
  rents: '',
  royalties: '',
  otherIncome: '',
  federalIncomeTaxWithheld: '',
  medicalPayments: '',
  substitutePayments: '',
  attorneyProceeds: '',
};

function buildMiscQuery(boxes: MiscBoxes): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(boxes)) {
    if (v.trim() && Number(v) !== 0) params.set(k, v.trim());
  }
  return params.toString();
}

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
  const { t } = useTranslation(['purchases', 'common']);
  const { companyId } = useCurrentCompany();
  const [formType, setFormType] = useState<FormType>('nec');
  const [year, setYear] = useState<number>(initialYear ?? currentYear() - 1);
  const [copy, setCopy] = useState<CopyType>('all');
  const [downloading, setDownloading] = useState(false);
  const [editingCompany, setEditingCompany] = useState(false);
  const [miscBoxes, setMiscBoxes] = useState<MiscBoxes>(EMPTY_MISC_BOXES);

  const necPreflightQ = useQuery({
    queryKey: ['1099-nec-preflight', companyId, vendorId, year],
    enabled: Boolean(companyId) && formType === 'nec',
    queryFn: () =>
      api<NecPreflightResp>(`/workers/${vendorId}/1099-nec/preflight?year=${year}`, {
        companyId,
      }),
  });

  const miscQuery = buildMiscQuery(miscBoxes);
  const miscPreflightQ = useQuery({
    queryKey: ['1099-misc-preflight', companyId, vendorId, year, miscQuery],
    enabled: Boolean(companyId) && formType === 'misc',
    queryFn: () =>
      api<MiscPreflightResp>(
        `/workers/${vendorId}/1099-misc/preflight?year=${year}${
          miscQuery ? `&${miscQuery}` : ''
        }`,
        { companyId },
      ),
  });

  // Common preflight-derived state, regardless of form type.
  const necData = formType === 'nec' ? necPreflightQ.data : null;
  const miscData = formType === 'misc' ? miscPreflightQ.data : null;
  const isLoading =
    formType === 'nec' ? necPreflightQ.isLoading : miscPreflightQ.isLoading;
  const isError = formType === 'nec' ? necPreflightQ.isError : miscPreflightQ.isError;
  const error = formType === 'nec' ? necPreflightQ.error : miscPreflightQ.error;
  const issues = necData?.issues ?? miscData?.issues ?? [];
  const hasData = !!(necData ?? miscData);
  const recipientName = necData?.recipient.displayName ?? miscData?.recipient.displayName ?? '';
  const hasW9 = necData?.hasW9 ?? miscData?.hasW9 ?? false;

  const blockerCount = issues.filter(
    (i) => i.fix === 'company-settings' || i.fix === 'worker-edit',
  ).length;
  const warningCount = issues.length - blockerCount;
  const canGenerate = hasData && blockerCount === 0;

  function refetchPreflight() {
    if (formType === 'nec') void necPreflightQ.refetch();
    else void miscPreflightQ.refetch();
  }

  async function downloadPdf() {
    if (!hasData) return;
    setDownloading(true);
    try {
      const token = await getIdToken();
      const url =
        formType === 'nec'
          ? `${getApiBase()}/workers/${vendorId}/1099-nec.pdf?year=${year}&copy=${copy}`
          : `${getApiBase()}/workers/${vendorId}/1099-misc.pdf?year=${year}&copy=${copy}${
              miscQuery ? `&${miscQuery}` : ''
            }`;
      const res = await fetch(url, {
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
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      const formLabel = formType === 'nec' ? '1099-NEC' : '1099-MISC';
      const safeName = `${recipientName.replace(/[^A-Za-z0-9]+/g, '_')}_${formLabel}_${year}_Copy${copy}.pdf`;
      a.download = safeName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      alert(err instanceof Error ? err.message : t('generate1099.downloadFailed'));
    } finally {
      setDownloading(false);
    }
  }

  // When the user toggles to MISC and hasn't entered any box values yet,
  // the route auto-fills Box 1 (rents) with YTD. The preflight surfaces this
  // via `defaultedToRents`. Keep `miscBoxes` empty so subsequent edits show
  // user intent vs the auto-fill.
  const miscDefaulted = miscData?.defaultedToRents ?? false;

  return (
    <div
      className="kpb-fade-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="kpb-pop-in my-8 w-full max-w-2xl space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              {t('generate1099.title', {
                form: formType === 'nec' ? '1099-NEC' : '1099-MISC',
              })}
            </h2>
            <p className="text-xs text-slate-500">
              {formType === 'nec' ? t('generate1099.necIntro') : t('generate1099.miscIntro')}{' '}
              {t('generate1099.sharedIntro')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common:close')}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        {/* Form-type toggle */}
        <div className="flex gap-2 rounded-md border border-slate-200 bg-slate-50 p-1 text-sm">
          {(['nec', 'misc'] as const).map((t) => {
            const active = formType === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setFormType(t)}
                className={
                  'flex-1 rounded px-3 py-1.5 transition-colors ' +
                  (active
                    ? 'bg-white font-medium text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800')
                }
              >
                {t === 'nec' ? '1099-NEC' : '1099-MISC'}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('generate1099.taxYear')}>
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
          <Field label={t('generate1099.copy')}>
            <select
              value={copy}
              onChange={(e) => setCopy(e.target.value as CopyType)}
              className={inputClass}
            >
              <option value="all">{t('generate1099.copyAll')}</option>
              <option value="B">{t('generate1099.copyB')}</option>
              <option value="C">{t('generate1099.copyC')}</option>
            </select>
          </Field>
        </div>

        {/* MISC box inputs */}
        {formType === 'misc' && (
          <div className="rounded-md border border-slate-200 bg-slate-50/50 p-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-slate-700">
                {t('generate1099.boxAmounts')}
              </h4>
              {miscData && (
                <span className="text-xs text-slate-500">
                  {t('generate1099.ytdPayments', { amount: formatUsd(miscData.yearTotal) })}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {t('generate1099.boxHint')}{' '}
              {miscDefaulted && <em>{t('generate1099.boxDefaulted')}</em>}
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(Object.keys(EMPTY_MISC_BOXES) as Array<keyof MiscBoxes>).map((key) => (
                <Field key={key} label={t(`generate1099.miscBox.${key}`)}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={miscBoxes[key]}
                    onChange={(e) => setMiscBoxes({ ...miscBoxes, [key]: e.target.value })}
                    placeholder={
                      key === 'rents' && miscDefaulted && miscData
                        ? t('generate1099.autoPlaceholder', { amount: miscData.yearTotal })
                        : '0.00'
                    }
                    className={inputClass + ' font-mono text-right'}
                  />
                </Field>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setMiscBoxes(EMPTY_MISC_BOXES)}
              className="mt-2 text-xs text-slate-500 underline hover:text-slate-700"
            >
              {t('generate1099.clearBoxes')}
            </button>
          </div>
        )}

        {isLoading && <p className="text-sm text-slate-500">{t('generate1099.checking')}</p>}
        {isError && (
          <p className="text-sm text-rose-600">
            {error instanceof Error ? error.message : t('generate1099.preflightFailed')}
          </p>
        )}

        {hasData && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <SummaryCard
                label={
                  formType === 'nec'
                    ? t('generate1099.paidIn', { year })
                    : t('generate1099.totalFiled', { year })
                }
                value={formatUsd(
                  formType === 'nec'
                    ? necData?.nonemployeeCompensation
                    : sumMiscBoxes(miscData),
                )}
                tone={
                  Number(
                    formType === 'nec'
                      ? necData?.nonemployeeCompensation
                      : sumMiscBoxes(miscData),
                  ) > 0
                    ? 'emerald'
                    : 'amber'
                }
              />
              <SummaryCard
                label={t('generate1099.w9OnFile')}
                value={hasW9 ? t('generate1099.w9Yes') : t('generate1099.w9No')}
                tone={hasW9 ? 'emerald' : 'amber'}
              />
            </div>

            {issues.length === 0 ? (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                {t('generate1099.allChecksPassed')}
              </div>
            ) : (
              <div className="space-y-2">
                {issues.map((issue, i) => (
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
                        <span className="font-medium">
                          {t(`generate1099.fixLabel.${issue.fix}`)}:
                        </span>{' '}
                        {issue.message}
                      </div>
                      {issue.fix === 'company-settings' && (
                        <button
                          type="button"
                          onClick={() => setEditingCompany(true)}
                          className="shrink-0 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-100"
                        >
                          {t('generate1099.fixHere')}
                        </button>
                      )}
                      {issue.fix === 'worker-edit' && (
                        <span className="shrink-0 text-xs italic">
                          {t('generate1099.editOnWorkerPage')}
                        </span>
                      )}
                      {issue.fix === 'upload-w9' && (
                        <span className="shrink-0 text-xs italic">
                          {t('generate1099.uploadFromWorkerPage')}
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
                  refetchPreflight();
                }}
              />
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                {t('common:close')}
              </button>
              <button
                type="button"
                onClick={downloadPdf}
                disabled={!canGenerate || downloading}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                title={
                  blockerCount > 0
                    ? t('generate1099.blockersTitle', { count: blockerCount })
                    : warningCount > 0
                      ? t('generate1099.warningsTitle')
                      : t('generate1099.generateTitle')
                }
              >
                {downloading
                  ? t('generate1099.generating')
                  : warningCount > 0 && blockerCount === 0
                    ? t('generate1099.generateAnyway', { count: warningCount })
                    : t('generate1099.generatePdf')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function sumMiscBoxes(data: MiscPreflightResp | null | undefined): string {
  if (!data) return '0';
  let total = 0;
  for (const v of Object.values(data.boxes)) {
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) total += n;
    }
  }
  return String(total);
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
  const { t } = useTranslation(['purchases', 'common']);
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
    return <div className="text-sm text-slate-500">{t('generate1099.company.loading')}</div>;
  }

  return (
    <div className="space-y-3 rounded-md border border-slate-300 bg-slate-50 p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-900">
          {t('generate1099.company.title')}
        </h4>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-500 underline hover:text-slate-700"
        >
          {t('generate1099.company.cancel')}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        <Trans
          t={t}
          i18nKey="generate1099.company.editingHint"
          values={{ name: data.name }}
          components={{ strong: <strong /> }}
        />
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label={t('generate1099.company.legalName')}>
          <input
            type="text"
            value={draft.legalName}
            onChange={(e) => setDraft({ ...draft, legalName: e.target.value })}
            maxLength={160}
            className={inputClass}
          />
        </Field>
        <Field label={t('generate1099.company.ein')} required>
          <input
            type="text"
            value={draft.ein}
            onChange={(e) => setDraft({ ...draft, ein: e.target.value })}
            placeholder="12-3456789"
            maxLength={20}
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label={t('generate1099.company.phone')}>
          <input
            type="tel"
            value={draft.phone}
            onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            maxLength={40}
            className={inputClass}
          />
        </Field>
        <Field label={t('generate1099.company.street')} required>
          <input
            type="text"
            value={draft.street1}
            onChange={(e) => setDraft({ ...draft, street1: e.target.value })}
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <Field label={t('generate1099.company.street2')}>
          <input
            type="text"
            value={draft.street2}
            onChange={(e) => setDraft({ ...draft, street2: e.target.value })}
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <Field label={t('generate1099.company.city')} required>
          <input
            type="text"
            value={draft.city}
            onChange={(e) => setDraft({ ...draft, city: e.target.value })}
            maxLength={100}
            className={inputClass}
          />
        </Field>
        <Field label={t('generate1099.company.state')} required>
          <input
            type="text"
            value={draft.state}
            onChange={(e) => setDraft({ ...draft, state: e.target.value })}
            maxLength={60}
            className={inputClass}
          />
        </Field>
        <Field label={t('generate1099.company.zip')} required>
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
        {mutation.isPending
          ? t('generate1099.company.saving')
          : t('generate1099.company.saveRecheck')}
      </button>
      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error, {
            error: t('errors.label'),
            fallback: t('errors.failed'),
          })}
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

function formatError(err: unknown, labels: { error: string; fallback: string }): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? labels.error}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : labels.fallback;
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
