/**
 * Determinate progress bar for uploads.
 *
 * Two states matter to the user and are visually distinct:
 *   - uploading: the fill tracks real bytes sent.
 *   - processing: bytes are gone and the server is working. The fill sits at
 *     100% and animates, because a static full bar during a long parse-and-
 *     commit reads as a hang.
 */
export function ProgressBar({
  percent,
  label,
  sublabel,
  indeterminate = false,
  tone = 'default',
}: {
  percent: number;
  label?: string;
  sublabel?: string;
  /** Server-side work: keep the bar full but moving. */
  indeterminate?: boolean;
  tone?: 'default' | 'success' | 'error';
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const fill =
    tone === 'error' ? 'bg-rose-500' : tone === 'success' ? 'bg-emerald-500' : 'bg-slate-900';

  return (
    <div className="space-y-1">
      {(label || sublabel) && (
        <div className="flex items-baseline justify-between gap-3 text-xs">
          {label && <span className="truncate text-slate-700">{label}</span>}
          {sublabel && <span className="shrink-0 font-mono text-slate-500">{sublabel}</span>}
        </div>
      )}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        // An indeterminate bar must not claim a value, or a screen reader
        // announces "100%" while the server is still working.
        {...(indeterminate ? {} : { 'aria-valuenow': clamped })}
        aria-label={label}
      >
        <div
          className={
            'h-full rounded-full transition-[width] duration-200 ease-out ' +
            fill +
            (indeterminate ? ' animate-pulse' : '')
          }
          style={{ width: `${indeterminate ? 100 : clamped}%` }}
        />
      </div>
    </div>
  );
}

/** Human-readable byte count for the "1.2 MB of 3.4 MB" line. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
