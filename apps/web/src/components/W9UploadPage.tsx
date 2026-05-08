import { useEffect, useState } from 'react';
import { getApiBase } from '../lib/api';

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

const REASON_MESSAGE: Record<NonNullable<TokenInfo['reason']>, string> = {
  not_found: "This upload link doesn't look valid. Double-check the URL or ask whoever sent it for a fresh link.",
  expired: "This upload link has expired. Ask whoever sent it for a fresh link — it'll arrive in your email shortly.",
  already_used: 'This link has already been used to upload a W-9. If you need to update it, reach out for a new link.',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
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
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export function W9UploadPage({ token }: { token: string }) {
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
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
            setLoadError(`Failed to load (HTTP ${res.status}).`);
          }
        } else {
          setInfo(body as TokenInfo);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Network error.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setUploadError('Pick a file first.');
      return;
    }
    if (file.size === 0) {
      setUploadError('That file looks empty.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError(`File is ${formatBytes(file.size)} — max is 10 MB.`);
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      const fileBase64 = await fileToBase64(file);
      const res = await fetch(`${getApiBase()}/w9-upload/${token}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          fileBase64,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const msg =
          (body && typeof body === 'object' && 'message' in body
            ? String((body as { message?: string }).message)
            : '') || `Upload failed (HTTP ${res.status}).`;
        throw new Error(msg);
      }
      setDone(true);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-xl space-y-6">
        <div className="text-center">
          <div className="text-2xl font-semibold tracking-tight text-slate-900">KPBooks</div>
          <div className="text-sm text-slate-500">Secure W-9 upload</div>
        </div>

        {loading && (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            Loading…
          </div>
        )}

        {!loading && loadError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-6 text-sm text-rose-800">
            {loadError}
          </div>
        )}

        {!loading && info && !info.valid && info.reason && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            <h2 className="text-base font-semibold">Link unavailable</h2>
            <p className="mt-2">{REASON_MESSAGE[info.reason]}</p>
          </div>
        )}

        {!loading && info && info.valid && !done && (
          <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">
                Upload your Form W-9
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                For <strong>{info.vendorName}</strong>, working with{' '}
                <strong>{info.companyName}</strong>. They need this on file for year-end 1099
                reporting (IRS requirement for any contractor paid $600+/year).
              </p>
              {info.expiresAt && (
                <p className="mt-2 text-xs text-slate-500">
                  This link expires on{' '}
                  <strong>{new Date(info.expiresAt).toLocaleDateString()}</strong>.
                </p>
              )}
            </div>

            <form onSubmit={onSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700">
                  W-9 file (PDF or photo)
                </label>
                <p className="mt-0.5 text-xs text-slate-500">
                  Don't have one yet? Download a blank Form W-9 from{' '}
                  <a
                    href="https://www.irs.gov/pub/irs-pdf/fw9.pdf"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-900 underline hover:text-slate-700"
                  >
                    irs.gov/pub/irs-pdf/fw9.pdf
                  </a>
                  , fill it in, sign, then come back here.
                </p>
                <input
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="mt-2 block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
                />
                {file && (
                  <p className="mt-1 text-xs text-slate-500">
                    Selected: <strong>{file.name}</strong> · {formatBytes(file.size)}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={!file || uploading}
                className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {uploading ? 'Uploading…' : 'Upload W-9'}
              </button>

              {uploadError && (
                <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                  {uploadError}
                </div>
              )}

              <p className="text-xs text-slate-500">
                Your file is sent over an encrypted connection and stored only on{' '}
                <strong>{info.companyName}</strong>'s account. This link is single-use — once you
                upload, it can't be used again.
              </p>
            </form>
          </div>
        )}

        {!loading && info && info.valid && done && (
          <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-900">
            <h2 className="text-base font-semibold">✓ Thanks — your W-9 is uploaded.</h2>
            <p>
              <strong>{info.companyName}</strong> has it on file now. You can close this tab.
            </p>
          </div>
        )}

        <p className="text-center text-xs text-slate-400">
          Powered by KPBooks · An accounting platform for accountants and small businesses
        </p>
      </div>
    </div>
  );
}
