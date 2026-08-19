import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface CreatedToken {
  id: string;
  token: string;
  expiresAt: string;
  vendorId: string;
  vendorName: string;
  emailTo: string | null;
  reused: boolean;
}

function buildUploadUrl(token: string): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/w9-upload/${token}`;
}

function buildMailToHref(token: CreatedToken, subject: string, body: string): string {
  const to = token.emailTo ? encodeURIComponent(token.emailTo) : '';
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function buildGmailHref(token: CreatedToken, subject: string, body: string): string {
  const to = token.emailTo ? encodeURIComponent(token.emailTo) : '';
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
}

export function RequestW9Modal({
  vendorId,
  vendorName,
  companyName,
  onClose,
}: {
  vendorId: string;
  vendorName: string;
  companyName: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation(['purchases', 'common']);
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [token, setToken] = useState<CreatedToken | null>(null);
  const [copied, setCopied] = useState(false);

  const mutation = useMutation({
    mutationFn: async () =>
      api<CreatedToken>(`/workers/${vendorId}/w9-request`, {
        method: 'POST',
        companyId,
      }),
    onSuccess: (data) => {
      setToken(data);
      void queryClient.invalidateQueries({ queryKey: ['worker', vendorId, companyId] });
    },
  });

  // Auto-fire on first mount.
  if (!token && !mutation.isPending && !mutation.isError) {
    mutation.mutate();
  }

  const url = token ? buildUploadUrl(token.token) : '';
  const emailSubject = t('w9Email.subject', {
    company: companyName ?? t('w9Email.fallbackCompany'),
  });
  const emailBodyFull = token
    ? t('w9Email.bodyFull', { vendor: token.vendorName, url })
    : '';
  const emailBodyShort = token
    ? t('w9Email.bodyShort', { vendor: token.vendorName, url })
    : '';

  async function copyUrl() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for browsers without clipboard API
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } finally {
        ta.remove();
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="my-8 w-full max-w-xl space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              {t('requestW9.title', { vendor: vendorName })}
            </h2>
            <p className="text-xs text-slate-500">{t('requestW9.subtitle')}</p>
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

        {mutation.isPending && (
          <p className="text-sm text-slate-500">{t('requestW9.generatingLink')}</p>
        )}

        {mutation.isError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {formatError(mutation.error, {
              error: t('errors.label'),
              fallback: t('errors.failed'),
            })}
          </div>
        )}

        {token && (
          <>
            {token.reused && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {t('requestW9.reused')}
              </div>
            )}

            <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <label className="block text-xs font-medium uppercase tracking-wider text-slate-500">
                {t('requestW9.uploadUrl')}
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={url}
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={copyUrl}
                  className="shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                >
                  {copied ? t('requestW9.copied') : t('requestW9.copy')}
                </button>
              </div>
              {token.emailTo ? (
                <p className="text-xs text-slate-500">
                  <Trans
                    t={t}
                    i18nKey="requestW9.emailOnFile"
                    values={{ email: token.emailTo }}
                    components={{ strong: <strong /> }}
                  />
                </p>
              ) : (
                <p className="text-xs text-rose-600">{t('requestW9.noEmail')}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
                {t('requestW9.sendByEmail')}
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={buildMailToHref(token, emailSubject, emailBodyFull)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                >
                  {t('requestW9.openDefaultMail')}
                </a>
                <a
                  href={buildGmailHref(token, emailSubject, emailBodyShort)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                >
                  {t('requestW9.composeGmail')}
                </a>
                <button
                  type="button"
                  onClick={copyUrl}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                >
                  {t('requestW9.copyUrl')}
                </button>
              </div>
              <p className="text-xs text-slate-500">{t('requestW9.shortcutsHint')}</p>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                {t('requestW9.done')}
              </button>
            </div>
          </>
        )}
      </div>
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
