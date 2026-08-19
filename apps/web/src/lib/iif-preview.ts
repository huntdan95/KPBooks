/**
 * Pure helpers for the IIF import preview, extracted from the Imports
 * component so the label logic is unit-testable (see
 * apps/api/test/iif-gauntlet.test.ts).
 */

export interface ExcludedTransaction {
  rowNumber: number;
  qbType: string;
  reason: string;
}

/** Localised prose the label is built from. */
export interface MapsToLabels {
  skipped: string;
  excluded: string;
}

/**
 * English defaults, used when no localised labels are supplied. This file
 * stays free of i18next so it remains a pure, node-testable module; callers
 * that render into the UI pass translated labels instead
 * (`t('shell:iifPreview.skippedNonPosting')` /
 * `t('shell:iifPreview.excludedDataError')`).
 */
const DEFAULT_LABELS: MapsToLabels = {
  skipped: 'skipped (non-posting)',
  excluded: 'excluded — data error (see warnings)',
};

/**
 * "Maps to" label for one row of the preview's per-TRNSTYPE table.
 *
 * `sample` is the first postable transaction of the type (undefined when
 * none survived parsing); `excludedOfType` counts blocks of the type that
 * were excluded at parse time for DATA ERRORS (out of balance, truncated).
 * Those excluded blocks are still counted in the per-type totals, so
 * without the third branch a type whose every block was excluded would be
 * mislabelled as skipped -- reading like an intentionally excluded document
 * class (estimates) instead of a data error the user must fix.
 *
 * The `journal_entry (<sourceType>)` branch is deliberately NOT translated:
 * both halves are internal identifiers the user matches against the import
 * log, not prose.
 */
export function mapsToLabel(
  sample: { posts: boolean; sourceType: string } | undefined,
  excludedOfType: number,
  labels: MapsToLabels = DEFAULT_LABELS,
): string {
  if (sample) {
    return sample.posts ? `journal_entry (${sample.sourceType})` : labels.skipped;
  }
  if (excludedOfType > 0) return labels.excluded;
  return labels.skipped;
}
