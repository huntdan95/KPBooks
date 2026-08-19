import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api, getApiBase, getIdToken } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

/**
 * StatementsPanel -- collapsible bulk-statement section for the Customers
 * page. Lets the bookkeeper pick a period, preview which customers have
 * activity or a non-zero balance, and download a per-customer PDF.
 *
 * Per-customer download = single PDF; "Download all" loops through and
 * downloads each. (Server-side ZIP would be cleaner but adds infra; this
 * works fine for the typical 5-50 customer book.)
 */

interface Candidate {
  customerId: string;
  displayName: string;
  email: string | null;
  closingBalance: string;
  activityRowCount: number;
}

interface CandidatesResp {
  periodStart: string;
  periodEnd: string;
  candidates: Candidate[];
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function startOfMonthIso(d = new Date()) {
  const dd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  return dd.toISOString().slice(0, 10);
}

function endOfMonthIso(d = new Date()) {
  const dd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return dd.toISOString().slice(0, 10);
}

function formatUsd(s: string | number): string {
  const n = typeof s === 'number' ? s : Number(s);
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

async function downloadStatement(opts: {
  customerId: string;
  customerName: string;
  periodStart: string;
  periodEnd: string;
  companyId: string | null;
}) {
  const token = await getIdToken();
  const url = `${getApiBase()}/customers/${opts.customerId}/statement.pdf?periodStart=${opts.periodStart}&periodEnd=${opts.periodEnd}`;
  const res = await fetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.companyId ? { 'x-kpbooks-company': opts.companyId } : {}),
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
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = `${opts.customerName.replace(/[^A-Za-z0-9]+/g, '_')}_Statement_${opts.periodEnd}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}

export function StatementsPanel() {
  const { t } = useTranslation('sales');
  const { companyId } = useCurrentCompany();
  const [open, setOpen] = useState(false);
  const [periodStart, setPeriodStart] = useState(startOfMonthIso());
  const [periodEnd, setPeriodEnd] = useState(endOfMonthIso());
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidatesQ = useQuery({
    queryKey: ['statements-candidates', companyId, periodStart, periodEnd],
    enabled: Boolean(companyId) && open,
    queryFn: () =>
      api<CandidatesResp>(
        `/statements/candidates?periodStart=${periodStart}&periodEnd=${periodEnd}`,
        { companyId },
      ),
  });

  const candidates = candidatesQ.data?.candidates ?? [];

  async function downloadOne(c: Candidate) {
    setDownloading((s) => new Set(s).add(c.customerId));
    setError(null);
    try {
      await downloadStatement({
        customerId: c.customerId,
        customerName: c.displayName,
        periodStart,
        periodEnd,
        companyId: companyId ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('statements.downloadFailed'));
    } finally {
      setDownloading((s) => {
        const next = new Set(s);
        next.delete(c.customerId);
        return next;
      });
    }
  }

  async function downloadAll() {
    setBulkRunning(true);
    setError(null);
    try {
      for (const c of candidates) {
        await downloadStatement({
          customerId: c.customerId,
          customerName: c.displayName,
          periodStart,
          periodEnd,
          companyId: companyId ?? null,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('statements.bulkFailed'));
    } finally {
      setBulkRunning(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
      >
        {t('statements.generate')}
      </button>
    );
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{t('statements.title')}</h3>
          <p className="text-xs text-slate-500">{t('statements.description')}</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-slate-500 underline hover:text-slate-700"
        >
          {t('statements.close')}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label={t('statements.periodStart')}>
          <input
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label={t('statements.periodEnd')}>
          <input
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className={inputClass}
          />
        </Field>
        <button
          type="button"
          onClick={() => {
            setPeriodStart(startOfMonthIso());
            setPeriodEnd(endOfMonthIso());
          }}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-xs hover:bg-slate-100"
        >
          {t('statements.thisMonth')}
        </button>
        <button
          type="button"
          onClick={() => {
            const d = new Date();
            d.setUTCMonth(d.getUTCMonth() - 1);
            setPeriodStart(startOfMonthIso(d));
            setPeriodEnd(endOfMonthIso(d));
          }}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-xs hover:bg-slate-100"
        >
          {t('statements.lastMonth')}
        </button>
      </div>

      {candidatesQ.isLoading && (
        <p className="mt-3 text-sm text-slate-500">{t('statements.loadingCandidates')}</p>
      )}
      {candidatesQ.isError && (
        <p className="mt-3 text-sm text-rose-600">
          {candidatesQ.error instanceof ApiError
            ? candidatesQ.error.message
            : t('shared.failedToLoad')}
        </p>
      )}
      {!candidatesQ.isLoading && candidates.length === 0 && (
        <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {t('statements.none')}
        </p>
      )}

      {candidates.length > 0 && (
        <>
          <div className="mt-3 overflow-hidden rounded-md border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t('shared.customer')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('shared.email')}</th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('statements.table.activityRows')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('statements.table.closingBalance')}
                  </th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {candidates.map((c) => {
                  const closingNum = Number(c.closingBalance);
                  return (
                    <tr key={c.customerId}>
                      <td className="px-3 py-2 text-slate-900">{c.displayName}</td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {c.email ?? <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-700">
                        {c.activityRowCount}
                      </td>
                      <td
                        className={
                          'px-3 py-2 text-right font-mono ' +
                          (closingNum > 0 ? 'text-slate-900 font-semibold' : 'text-slate-500')
                        }
                      >
                        {formatUsd(c.closingBalance)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => downloadOne(c)}
                          disabled={downloading.has(c.customerId) || bulkRunning}
                          className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                        >
                          {downloading.has(c.customerId)
                            ? t('statements.downloading')
                            : t('download', { ns: 'common' })}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={downloadAll}
              disabled={bulkRunning || candidates.length === 0}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {bulkRunning
                ? t('statements.bulkRunning', { count: candidates.length })
                : t('statements.downloadAll', { count: candidates.length })}
            </button>
            <p className="text-xs text-slate-500">{t('statements.downloadHint')}</p>
          </div>

          {error && (
            <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const inputClass =
  'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-slate-600">
      <span>{label}</span>
      {children}
    </label>
  );
}
