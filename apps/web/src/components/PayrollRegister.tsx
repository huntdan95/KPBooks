import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type WorkerType = 'contractor' | 'employee' | 'subcontractor' | 'not_a_worker';

interface PayrollRegisterRow {
  vendorId: string;
  displayName: string;
  workerType: WorkerType;
  taxId: string | null;
  workersCompClass: string | null;
  paySchedule: string | null;
  paymentCount: number;
  totalPaid: string;
}

interface PayrollRegisterResp {
  from: string;
  to: string;
  rows: PayrollRegisterRow[];
  totals: {
    totalPaid: string;
    totalPayments: number;
    byWorkerType: Array<{
      workerType: WorkerType;
      count: number;
      total: string;
    }>;
  };
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const firstOfMonth = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

function formatUsd(s: string | number): string {
  if (s === null || s === undefined || s === '') return '$0.00';
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const TYPE_LABEL_KEY: Record<WorkerType, string> = {
  contractor: 'register.type.contractor',
  subcontractor: 'register.type.subcontractor',
  employee: 'register.type.employee',
  not_a_worker: 'register.type.notAWorker',
};

const TYPE_TONE: Record<WorkerType, string> = {
  contractor: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  subcontractor: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  employee: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  not_a_worker: 'bg-slate-100 text-slate-600 ring-slate-300',
};

export function PayrollRegister() {
  const { t } = useTranslation(['payroll', 'common']);
  const { companyId } = useCurrentCompany();
  const [from, setFrom] = useState<string>(firstOfMonth);
  const [to, setTo] = useState<string>(todayIso);
  const [workerType, setWorkerType] = useState<'' | 'contractor' | 'employee' | 'subcontractor'>(
    '',
  );

  const params = new URLSearchParams({ from, to });
  if (workerType) params.set('workerType', workerType);

  const query = useQuery({
    queryKey: ['payroll-register', companyId, from, to, workerType],
    enabled: Boolean(companyId) && Boolean(from) && Boolean(to),
    queryFn: () =>
      api<PayrollRegisterResp>(`/ledger/reports/payroll-register?${params.toString()}`, {
        companyId,
      }),
  });

  const data = query.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('common:from')}>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label={t('common:to')}>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label={t('register.classification')}>
          <select
            value={workerType}
            onChange={(e) =>
              setWorkerType(e.target.value as '' | 'contractor' | 'employee' | 'subcontractor')
            }
            className={inputClass}
          >
            <option value="">{t('register.filter.all')}</option>
            <option value="employee">{t('register.filter.employees')}</option>
            <option value="contractor">{t('register.filter.contractors')}</option>
            <option value="subcontractor">{t('register.filter.subcontractors')}</option>
          </select>
        </Field>
      </div>

      <p className="text-xs text-slate-500">
        {t('register.blurb')} <code>payments</code> WHERE{' '}
        <code>payment_type='vendor_sent' AND status='posted'</code>.
      </p>

      {query.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : t('failedToLoad')}
        </p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Tile
              label={t('register.totalPayroll')}
              value={formatUsd(data.totals.totalPaid)}
              hint={t('register.paymentCount', { count: data.totals.totalPayments })}
              tone="slate"
            />
            {data.totals.byWorkerType
              .filter((b) => b.workerType !== 'not_a_worker')
              .sort((a, b) => Number(b.total) - Number(a.total))
              .slice(0, 2)
              .map((b) => (
                <Tile
                  key={b.workerType}
                  label={t(TYPE_LABEL_KEY[b.workerType])}
                  value={formatUsd(b.total)}
                  hint={t('register.paymentCount', { count: b.count })}
                  tone="slate"
                />
              ))}
          </div>

          {data.rows.length === 0 ? (
            <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
              {t('register.empty')}
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('register.columns.worker')}
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('register.columns.type')}
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('register.columns.taxId')}
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('register.columns.wcClass')}
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('register.columns.schedule')}
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      {t('register.columns.payments')}
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      {t('register.columns.totalPaid')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {data.rows.map((r) => (
                    <tr key={r.vendorId} className={r.paymentCount === 0 ? 'opacity-60' : ''}>
                      <td className="px-4 py-2 text-slate-900">{r.displayName}</td>
                      <td className="px-4 py-2">
                        <span
                          className={
                            'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                            TYPE_TONE[r.workerType]
                          }
                        >
                          {t(TYPE_LABEL_KEY[r.workerType])}
                        </span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-600">
                        {r.taxId
                          ? r.taxId.replace(/.(?=.{4})/g, '•').slice(-9)
                          : <span className="text-rose-600">{t('register.missing')}</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-700">
                        {r.workersCompClass || (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-700">
                        {r.paySchedule || <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-slate-700">
                        {r.paymentCount}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-slate-900">
                        {formatUsd(r.totalPaid)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-100 text-sm font-semibold">
                  <tr>
                    <td colSpan={5} className="px-4 py-3 text-right text-slate-900">
                      {t('register.totalRange', { from: data.from, to: data.to })}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {data.totals.totalPayments}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-900">
                      {formatUsd(data.totals.totalPaid)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <p className="text-xs text-slate-500">{t('register.tip')}</p>
        </>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: 'slate' | 'emerald' | 'rose';
}) {
  const cls = {
    slate: 'border-slate-200 bg-white text-slate-900',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
  }[tone];
  return (
    <div className={'rounded-md border p-3 ' + cls}>
      <div className="text-xs uppercase tracking-wider opacity-70">{label}</div>
      <div className="mt-1 font-mono text-xl">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] opacity-60">{hint}</div>}
    </div>
  );
}

const inputClass =
  'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-slate-900 focus:outline-none';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-slate-600">
      <span>{label}</span>
      {children}
    </label>
  );
}
