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

/**
 * "Maps to" label for one row of the preview's per-TRNSTYPE table.
 *
 * `sample` is the first postable transaction of the type (undefined when
 * none survived parsing); `excludedOfType` counts blocks of the type that
 * were excluded at parse time for DATA ERRORS (out of balance, truncated).
 * Those excluded blocks are still counted in the per-type totals, so
 * without the third branch a type whose every block was excluded would be
 * mislabelled "skipped (non-posting)" -- reading like an intentionally
 * excluded document class (estimates) instead of a data error the user
 * must fix.
 */
export function mapsToLabel(
  sample: { posts: boolean; sourceType: string } | undefined,
  excludedOfType: number,
): string {
  if (sample) {
    return sample.posts ? `journal_entry (${sample.sourceType})` : 'skipped (non-posting)';
  }
  if (excludedOfType > 0) return 'excluded — data error (see warnings)';
  return 'skipped (non-posting)';
}
