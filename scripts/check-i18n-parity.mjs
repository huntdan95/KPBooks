#!/usr/bin/env node
/**
 * i18n parity guard: every EN key must exist in ES with matching
 * {{interpolation}} variables (a mismatched variable renders a literal
 * "{{count}}" to the user).
 *
 * Run: node scripts/check-i18n-parity.mjs   (exits non-zero on any gap)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps/web/src/i18n/locales');

const flat = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [`${p}${k}`],
  );
const leaf = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? leaf(v, `${p}${k}.`) : [[`${p}${k}`, v]],
  );
const vars = (s) => (String(s).match(/\{\{\s*\w+/g) || []).sort().join(',');

let problems = 0;
let total = 0;

for (const f of readdirSync(join(LOCALES, 'en'))) {
  const en = JSON.parse(readFileSync(join(LOCALES, 'en', f), 'utf8'));
  const es = JSON.parse(readFileSync(join(LOCALES, 'es', f), 'utf8'));
  const ek = flat(en);
  const sk = flat(es);
  total += ek.length;

  const missing = ek.filter((k) => !sk.includes(k));
  const extra = sk.filter((k) => !ek.includes(k));
  const em = new Map(leaf(en));
  const sm = new Map(leaf(es));
  const varMismatch = [...em.keys()].filter((k) => sm.has(k) && vars(em.get(k)) !== vars(sm.get(k)));

  problems += missing.length + extra.length + varMismatch.length;
  console.log(
    `${f.padEnd(16)} en=${String(ek.length).padStart(4)} es=${String(sk.length).padStart(4)} ` +
      `missing=${missing.length} extra=${extra.length} varMismatch=${varMismatch.length}`,
  );
  if (missing.length) console.error('   MISSING:', missing.slice(0, 10));
  if (extra.length) console.error('   EXTRA:', extra.slice(0, 10));
  if (varMismatch.length) console.error('   VAR MISMATCH:', varMismatch.slice(0, 10));
}

console.log(`\nTOTAL KEYS: ${total}`);
if (problems) {
  console.error(`FAILED: ${problems} parity problem(s)`);
  process.exit(1);
}
console.log('PARITY OK');
