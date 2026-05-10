/**
 * Single inline-SVG icon component. Lightweight (no dependency); each icon is
 * a 24×24 stroke=currentColor path so colour follows the parent's text-* and
 * size follows w-* / h-* tailwind classes.
 *
 * Naming follows lucide-react / heroicons style names so future migration
 * to a real icon library is mechanical.
 */
import type { JSX } from 'react';

export type IconName =
  | 'dashboard'
  | 'sparkles'
  | 'file-text'
  | 'file-stack'
  | 'users'
  | 'package'
  | 'credit-card'
  | 'receipt'
  | 'building-2'
  | 'car'
  | 'briefcase'
  | 'clock'
  | 'wallet'
  | 'banknote'
  | 'piggy-bank'
  | 'book-open'
  | 'plus-square'
  | 'repeat'
  | 'truck'
  | 'upload-cloud'
  | 'bar-chart'
  | 'history'
  | 'percent'
  | 'badge-check'
  | 'plus'
  | 'check'
  | 'x'
  | 'chevron-down'
  | 'chevron-right'
  | 'arrow-right'
  | 'arrow-up-right'
  | 'arrow-down-right'
  | 'log-out'
  | 'inbox'
  | 'search'
  | 'alert-triangle'
  | 'alert-circle'
  | 'info'
  | 'trending-up'
  | 'trending-down'
  | 'circle-dollar';

interface IconProps {
  name: IconName;
  className?: string;
  /** Override the default 1.75 stroke-width (e.g. 2 for emphasis, 1.5 for subtle). */
  strokeWidth?: number;
  'aria-hidden'?: boolean | 'true' | 'false';
}

const PATHS: Record<IconName, JSX.Element> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3l1.5 4 4 1.5-4 1.5L12 14l-1.5-4-4-1.5 4-1.5z" />
      <path d="M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </>
  ),
  'file-text': (
    <>
      <path d="M14 3v5h5" />
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="14" y2="17" />
    </>
  ),
  'file-stack': (
    <>
      <path d="M16 2H8a2 2 0 0 0-2 2v2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2h2a2 2 0 0 0 2-2V6z" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  package: (
    <>
      <path d="M16.5 9.4l-9-5.19" />
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </>
  ),
  'credit-card': (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </>
  ),
  receipt: (
    <>
      <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2z" />
      <line x1="8" y1="9" x2="16" y2="9" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </>
  ),
  'building-2': (
    <>
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18" />
      <path d="M6 12h12" />
      <path d="M6 18h12" />
      <path d="M10 6h4" />
    </>
  ),
  car: (
    <>
      <path d="M19 17h2v-3l-1.5-4.5A2 2 0 0 0 17.6 8H6.4a2 2 0 0 0-1.9 1.5L3 14v3h2" />
      <circle cx="7" cy="17" r="2" />
      <circle cx="17" cy="17" r="2" />
    </>
  ),
  briefcase: (
    <>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>
  ),
  wallet: (
    <>
      <path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1" />
      <path d="M16 12h5v4h-5a2 2 0 0 1 0-4z" />
    </>
  ),
  banknote: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  'piggy-bank': (
    <>
      <path d="M19 5c-1.5 0-2.8 1.4-3 2-3.5-1.5-7.5-1-10 1-2 1.5-3 4-2 6 .5 1 1.5 2 3 2.5 0 1 .5 2 1 2.5L9 21h2v-2h2v2h2l1-2c1-.5 2-1.5 2-2.5h2v-3h-2c-.5-1-1-1.5-2-2 0-.5 0-1 0-1.5 1 0 2-.5 2-1.5z" />
      <circle cx="9" cy="11" r="0.5" fill="currentColor" />
    </>
  ),
  'book-open': (
    <>
      <path d="M2 5h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2z" />
      <path d="M22 5h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z" />
    </>
  ),
  'plus-square': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </>
  ),
  repeat: (
    <>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </>
  ),
  truck: (
    <>
      <rect x="1" y="6" width="14" height="12" rx="1" />
      <path d="M15 9h4l3 3v5h-7" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="19" r="2" />
    </>
  ),
  'upload-cloud': (
    <>
      <polyline points="16 16 12 12 8 16" />
      <line x1="12" y1="12" x2="12" y2="21" />
      <path d="M20 16.7A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.3" />
      <polyline points="16 16 12 12 8 16" />
    </>
  ),
  'bar-chart': (
    <>
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
      <line x1="3" y1="20" x2="21" y2="20" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <polyline points="3 4 3 8 7 8" />
      <line x1="12" y1="7" x2="12" y2="12" />
      <line x1="12" y1="12" x2="15" y2="14" />
    </>
  ),
  percent: (
    <>
      <line x1="19" y1="5" x2="5" y2="19" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </>
  ),
  'badge-check': (
    <>
      <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76z" />
      <polyline points="9 12 11 14 15 10" />
    </>
  ),
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  check: (
    <>
      <polyline points="20 6 9 17 4 12" />
    </>
  ),
  x: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  'chevron-down': (
    <>
      <polyline points="6 9 12 15 18 9" />
    </>
  ),
  'chevron-right': (
    <>
      <polyline points="9 18 15 12 9 6" />
    </>
  ),
  'arrow-right': (
    <>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </>
  ),
  'arrow-up-right': (
    <>
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="7 7 17 7 17 17" />
    </>
  ),
  'arrow-down-right': (
    <>
      <line x1="7" y1="7" x2="17" y2="17" />
      <polyline points="17 7 17 17 7 17" />
    </>
  ),
  'log-out': (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </>
  ),
  inbox: (
    <>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  'alert-triangle': (
    <>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>
  ),
  'alert-circle': (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>
  ),
  'trending-up': (
    <>
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </>
  ),
  'trending-down': (
    <>
      <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" />
      <polyline points="17 18 23 18 23 12" />
    </>
  ),
  'circle-dollar': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
      <line x1="12" y1="6" x2="12" y2="18" />
    </>
  ),
};

export function Icon({
  name,
  className,
  strokeWidth = 1.75,
  ...rest
}: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-4 w-4'}
      aria-hidden={rest['aria-hidden'] ?? true}
    >
      {PATHS[name]}
    </svg>
  );
}
