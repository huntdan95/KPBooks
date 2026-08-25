import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { getApiBase , ApiError, apiUpload, type UploadProgress } from '../lib/api';
import { ProgressBar } from './ui/ProgressBar';

/**
 * Public (no auth) page for contractors to upload their W-9.
 *
 * Flow:
 *   1. Mount: GET /v1/w9-upload/:token/info -> returns vendor + company name
 *      OR a friendly "expired / already used" message.
 *   2. User picks a file (PDF or image), clicks Upload.
 *   3. POST /v1/w9-upload/:token/upload (base64 in JSON, same as the authed
 *      worker-documents endpoint).
 *   4. On success, show a thank-you screen.
 *
 * No app shell, no sidebar, no company picker -- this page is rendered
 * BEFORE the auth flow in App.tsx, so it's intentionally minimal and
 * friendly to a non-technical contractor.
 */

interface TokenInfo {
  valid: boolean;
  reason?: 'not_found' | 'expired' | 'already_used';
  vendorName?: string | null;
  companyName?: string | null;
  expiresAt?: string | null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fileToBase64(file: File, readErrorMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error(readErrorMessage));
        return;
      }
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error(readErrorMessage));
    reader.readAsDataURL(file);
  });
}

export function W9UploadPage({ token }: { token: string }) {
  const { t } = useTranslation(['purchases', 'common']);
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Contractors upload phone photos of a W-9 over cell data, where a few MB
  // is slow enough that a silent spinner looks broken.
  const [progress, setProgress] = useState<{
    phase: UploadProgress['phase'];
    percent: number;
  } | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/w9-upload/${token}/info`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          // 404/410 also return JSON with reason; surface that.
          if (body && typeof body === 'object' && 'reason' in body) {
            setInfo(body as TokenInfo);
          } else {
            setLoadError(t('w9Upload.loadFailedHttp', { status: res.status }));
          }
        } else {
          setInfo(body as TokenInfo);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : t('w9Upload.networkError'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setUploadError(t('w9Upload.pickFileFirst'));
      return;
    }
    if (file.size === 0) {
      setUploadError(t('w9Upload.emptyFile'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError(t('w9Upload.tooLarge', { size: formatBytes(file.size) }));
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      const fileBase64 = await fileToBase64(file, t('w9Upload.readFailed'));
      try {
        await apiUpload(`/w9-upload/${token}/upload`, {
          method: 'POST',
          body: {
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            fileBase64,
          },
          onProgress: (pr) => setProgress({ phase: pr.phase, percent: pr.percent }),
        });
      } catch (err) {
        // Same precedence as before: the server message wins, then a
        // status-based fallback.
        if (err instanceof ApiError) {
          const body = err.body;
          const msg =
            (body && typeof body === 'object' && 'message' in body
              ? String((body as { message?: string }).message)
              : '') || t('w9Upload.uploadFailedHttp', { status: err.status });
          throw new Error(msg);
        }
        throw err;
      }
      setDone(true);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t('w9Upload.uploadFailed'));
    } finally {
      setUploading(false);
      setProgress(null);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-xl space-y-6">
        <div className="text-center">
          <div className="text-2xl font-semibold tracking-tight text-slate-900">KPBooks</div>
          <div className="text-sm text-slate-500">{t('w9Upload.header')}</div>
        </div>

        {loading && (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            {t('common:loading')}
          </div>
        )}

        {!loading && loadError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-6 text-sm text-rose-800">
            {loadError}
          </div>
        )}

        {!loading && info && !info.valid && info.reason && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            <h2 className="text-base font-semibold">{t('w9Upload.linkUnavailable')}</h2>
            <p className="mt-2">{t(`w9Upload.reason.${info.reason}`)}</p>
          </div>
        )}

        {!loading && info && info.valid && !done && (
          <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">
                {t('w9Upload.title')}
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                <Trans
                  t={t}
                  i18nKey="w9Upload.intro"
                  values={{ vendor: info.vendorName, company: info.companyName }}
                  components={{ strong: <strong /> }}
                />
              </p>
              {info.expiresAt && (
                <p className="mt-2 text-xs text-slate-500">
                  <Trans
                    t={t}
                    i18nKey="w9Upload.expires"
                    values={{ date: new Date(info.expiresAt).toLocaleDateString() }}
                    components={{ strong: <strong /> }}
                  />
                </p>
              )}
            </div>

            <form onSubmit={onSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700">
                  {t('w9Upload.fileLabel')}
                </label>
                <p className="mt-0.5 text-xs text-slate-500">
                  {t('w9Upload.blankFormPre')}{' '}
                  <a
                    href="https://www.irs.gov/pub/irs-pdf/fw9.pdf"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-900 underline hover:text-slate-700"
                  >
                    irs.gov/pub/irs-pdf/fw9.pdf
                  </a>
                  {t('w9Upload.blankFormPost')}
                </p>
                <input
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="mt-2 block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
                />
                {file && (
                  <p className="mt-1 text-xs text-slate-500">
                    <Trans
                      t={t}
                      i18nKey="w9Upload.selectedFile"
                      values={{ name: file.name, size: formatBytes(file.size) }}
                      components={{ strong: <strong /> }}
                    />
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={!file || uploading}
                className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {uploading ? t('w9Upload.uploading') : t('w9Upload.uploadCta')}
              </button>

              {progress && (
                <ProgressBar
                  percent={progress.percent}
                  indeterminate={progress.phase === 'processing'}
                  label={
                    progress.phase === 'processing'
                      ? t('w9Upload.progress.processing')
                      : t('w9Upload.progress.uploading')
                  }
                  sublabel={`${progress.percent}%`}
                />
              )}

              {uploadError && (
                <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                  {uploadError}
                </div>
              )}

              <p className="text-xs text-slate-500">
                <Trans
                  t={t}
                  i18nKey="w9Upload.privacy"
                  values={{ company: info.companyName }}
                  components={{ strong: <strong /> }}
                />
              </p>
            </form>
          </div>
        )}

        {!loading && info && info.valid && done && (
          <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-900">
            <h2 className="text-base font-semibold">{t('w9Upload.thanks')}</h2>
            <p>
              <Trans
                t={t}
                i18nKey="w9Upload.onFileNow"
                values={{ company: info.companyName }}
                components={{ strong: <strong /> }}
              />
            </p>
          </div>
        )}

        <p className="text-center text-xs text-slate-400">{t('w9Upload.poweredBy')}</p>
      </div>
    </div>
  );
}
