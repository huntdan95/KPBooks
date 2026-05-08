import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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

function buildMailToHref(token: CreatedToken, companyName: string | null): string {
  const url = buildUploadUrl(token.token);
  const subject = encodeURIComponent(`W-9 needed for ${companyName ?? 'your work'}`);
  const body = encodeURIComponent(
    `Hi ${token.vendorName},\n\n` +
      `For year-end 1099 reporting we need a current Form W-9 on file. ` +
      `Please upload yours via the secure link below — no account needed:\n\n` +
      `${url}\n\n` +
      `If you don't have a blank W-9 handy, download one at\n` +
      `https://www.irs.gov/pub/irs-pdf/fw9.pdf\n\n` +
      `The link is good for 30 days and is single-use.\n\n` +
      `Thanks!`,
  );
  const to = token.emailTo ? encodeURIComponent(token.emailTo) : '';
  return `mailto:${to}?subject=${subject}&body=${body}`;
}

function buildGmailHref(token: CreatedToken, companyName: string | null): string {
  const url = buildUploadUrl(token.token);
  const subject = encodeURIComponent(`W-9 needed for ${companyName ?? 'your work'}`);
  const body = encodeURIComponent(
    `Hi ${token.vendorName},\n\n` +
      `For year-end 1099 reporting we need a current Form W-9 on file. ` +
      `Please upload yours via the secure link below — no account needed:\n\n` +
      `${url}\n\n` +
      `Thanks!`,
  );
  const to = token.emailTo ? encodeURIComponent(token.emailTo) : '';
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${subject}&body=${body}`;
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
              Request W-9 from {vendorName}
            </h2>
            <p className="text-xs text-slate-500">
              Generates a single-use upload link the contractor can open in any browser. No
              login required. The link expires in 30 days.
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

        {mutation.isPending && <p className="text-sm text-slate-500">Generating link…</p>}

        {mutation.isError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {formatError(mutation.error)}
          </div>
        )}

        {token && (
          <>
            {token.reused && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                A previous link was still active for this contractor — re-using it instead of
                minting a new one. Same URL the contractor already has (if you sent it before).
              </div>
            )}

            <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <label className="block text-xs font-medium uppercase tracking-wider text-slate-500">
                Upload URL
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
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              {token.emailTo ? (
                <p className="text-xs text-slate-500">
                  Recipient email on file: <strong>{token.emailTo}</strong>
                </p>
              ) : (
                <p className="text-xs text-rose-600">
                  No email on file for this contractor — add one on the Worker page so the email
                  shortcuts pre-fill the recipient.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
                Send by email
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={buildMailToHref(token, companyName)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                >
                  Open in default mail
                </a>
                <a
                  href={buildGmailHref(token, companyName)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                >
                  Compose in Gmail
                </a>
                <button
                  type="button"
                  onClick={copyUrl}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                >
                  Copy URL
                </button>
              </div>
              <p className="text-xs text-slate-500">
                Both shortcuts open a pre-filled draft. Review and hit send from your own email
                — KPBooks never sends mail on your behalf.
              </p>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
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
