/**
 * Loading skeleton primitives. Use instead of "Loading…" text in places where
 * the layout is known ahead of time -- the user gets visual continuity rather
 * than a layout shift when data lands.
 *
 * Animation: pulse only (no shimmer) -- shimmer is harder to do without
 * extra CSS and the pulse is enough for a 200-500ms loading state.
 */

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={
        'animate-pulse rounded bg-slate-200/70 ' + (className ?? 'h-4 w-full')
      }
      aria-hidden
    />
  );
}

/** Skeleton bar grid for KPI tiles. */
export function SkeletonStat() {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-3 w-20" />
    </div>
  );
}

/** Skeleton rows for tables. */
export function SkeletonRows({ rows = 3, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-slate-200">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton
              key={c}
              className={
                'h-3 ' + (c === 0 ? 'w-32' : c === cols - 1 ? 'w-20 ml-auto' : 'w-24')
              }
            />
          ))}
        </div>
      ))}
    </div>
  );
}
