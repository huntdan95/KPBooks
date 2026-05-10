import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Standardized empty-state block. Use in place of bare "No X yet." paragraphs
 * for screens where the user might wonder whether the page is broken vs
 * genuinely empty. Includes an optional CTA button.
 */
export function EmptyState({
  icon = 'inbox',
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <Icon name={icon} className="h-5 w-5" />
      </div>
      <h3 className="mt-3 text-sm font-medium text-slate-900">{title}</h3>
      {description && (
        <p className="mt-1 text-sm text-slate-500">{description}</p>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          <Icon name="plus" className="h-3.5 w-3.5" strokeWidth={2.25} />
          {action.label}
        </button>
      )}
    </div>
  );
}
