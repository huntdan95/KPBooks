#!/usr/bin/env node
/**
 * i18n regression guard: resolve every t() call site against both locales.
 *
 * Catches the failure mode that typecheck and key-parity both miss — a
 * component calling t() with a key that doesn't exist, or with a namespace
 * it never declared in useTranslation(). Either one renders the raw key
 * ("reports.trialBalance.title") on screen instead of text.
 *
 * Run: node scripts/check-i18n.mjs   (exits non-zero on any unresolved key)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = join(ROOT, 'apps/web/src/i18n/locales');
const COMPONENTS = join(ROOT, 'apps/web/src/components');

const res = {};
for (const lang of ['en', 'es']) {
  res[lang] = {};
  for (const f of readdirSync(join(LOCALES, lang))) {
    res[lang][f.replace('.json', '')] = JSON.parse(readFileSync(join(LOCALES, lang, f), 'utf8'));
  }
}

const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);

const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.tsx')) files.push(p);
  }
})(COMPONENTS);
files.push(join(ROOT, 'apps/web/src/App.tsx'));

const missing = [];
let checked = 0;

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const decl = [...src.matchAll(/useTranslation\(\s*(\[[^\]]*\]|'[^']*')/g)].flatMap((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]),
  );
  if (!decl.length) continue;
  const primary = decl[0];

  for (const m of src.matchAll(/\bt\(\s*'([^']+)'((?:[^)]|\([^)]*\)){0,90})/g)) {
    const raw = m[1];
    const tail = m[2] || '';
    // Skip dynamic keys and SCREAMING_CASE constants.
    if (raw.includes('${') || /^[A-Z_]+$/.test(raw)) continue;

    let ns = primary;
    let key = raw;
    if (raw.includes(':')) {
      [ns, key] = raw.split(':');
    } else {
      const nsOpt = tail.match(/\bns:\s*'([^']+)'/);
      if (nsOpt) ns = nsOpt[1];
    }
    checked++;

    if (!res.en[ns]) {
      missing.push(`${basename(f)}: t('${raw}') -> unknown namespace "${ns}"`);
      continue;
    }
    for (const lang of ['en', 'es']) {
      const v = get(res[lang][ns], key);
      // i18next plural keys live as key_one / key_other.
      const plural = v === undefined && get(res[lang][ns], `${key}_other`) !== undefined;
      if (v === undefined && !plural) {
        missing.push(`${basename(f)}: [${lang}] ${ns}:${key} UNRESOLVED`);
      }
    }
  }
}

console.log(`Checked ${checked} t() call sites across ${files.length} files`);
if (missing.length) {
  console.error(`UNRESOLVED (${missing.length}):`);
  for (const line of [...new Set(missing)]) console.error('  ' + line);
  process.exit(1);
}
console.log('ALL KEYS RESOLVE IN BOTH LANGUAGES');
