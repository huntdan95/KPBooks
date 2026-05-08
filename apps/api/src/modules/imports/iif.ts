import {
  type Database,
  accounts as accountsTable,
  customers as customersTable,
  vendors as vendorsTable,
} from '@kpbooks/db';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

/**
 * iif.ts -- parser + committer for QuickBooks IIF (Intuit Interchange Format)
 * exports.
 *
 * IIF is tab-separated. Lines starting with `!` define column order for the
 * section that follows. Lines starting with the same section name (no `!`)
 * are data rows. Sections we care about for v1 lists import:
 *
 *   !ACCNT  ...columns...    -- chart of accounts
 *   !CUST   ...columns...    -- customers
 *   !VEND   ...columns...    -- vendors
 *
 * Other sections (TRNS+SPL transactions, INVITEM, EMP, CLASS, etc.) are
 * ignored for v1. We also ignore subaccounts (parent-child) -- everything
 * lands flat. That keeps the slice tight; transaction + hierarchy support
 * is a follow-up slice.
 */

// ------------------------- Types --------------------------------------------

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type AccountSubtype =
  | 'bank'
  | 'accounts_receivable'
  | 'other_current_asset'
  | 'fixed_asset'
  | 'other_asset'
  | 'accounts_payable'
  | 'credit_card'
  | 'other_current_liability'
  | 'long_term_liability'
  | 'equity'
  | 'retained_earnings'
  | 'income'
  | 'other_income'
  | 'expense'
  | 'cost_of_goods_sold'
  | 'other_expense';

export interface ParsedAccount {
  name: string;
  qbType: string; // raw ACCNTTYPE value from the file (BANK, AR, INC, etc.)
  type: AccountType;
  subtype: AccountSubtype;
  description?: string | undefined;
  /** Auto-assigned suggestion: a 4-digit code derived from type ordering. */
  suggestedCode: string;
}

export interface ParsedCustomer {
  displayName: string;
  companyName?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  notes?: string | undefined;
  defaultTermsDays?: number | undefined;
}

export interface ParsedVendor {
  displayName: string;
  companyName?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  notes?: string | undefined;
  defaultTermsDays?: number | undefined;
  is1099Vendor: boolean;
  taxId?: string | undefined;
}

export interface IifPreview {
  accounts: ParsedAccount[];
  customers: ParsedCustomer[];
  vendors: ParsedVendor[];
  /** Lines we couldn't classify -- shown so the user knows what was ignored. */
  unrecognizedSections: string[];
  /** Parser warnings (unmapped account types, malformed rows, etc.). */
  warnings: string[];
}

// ------------------------- ACCNTTYPE map ------------------------------------

const ACCNT_TYPE_MAP: Record<string, { type: AccountType; subtype: AccountSubtype }> = {
  BANK: { type: 'asset', subtype: 'bank' },
  CCARD: { type: 'liability', subtype: 'credit_card' },
  AR: { type: 'asset', subtype: 'accounts_receivable' },
  AP: { type: 'liability', subtype: 'accounts_payable' },
  OCASSET: { type: 'asset', subtype: 'other_current_asset' },
  FIXASSET: { type: 'asset', subtype: 'fixed_asset' },
  OASSET: { type: 'asset', subtype: 'other_asset' },
  OCLIAB: { type: 'liability', subtype: 'other_current_liability' },
  LTLIAB: { type: 'liability', subtype: 'long_term_liability' },
  EQUITY: { type: 'equity', subtype: 'equity' },
  INC: { type: 'revenue', subtype: 'income' },
  OINC: { type: 'revenue', subtype: 'other_income' },
  EXP: { type: 'expense', subtype: 'expense' },
  COGS: { type: 'expense', subtype: 'cost_of_goods_sold' },
  EXEXP: { type: 'expense', subtype: 'other_expense' },
  EXINC: { type: 'revenue', subtype: 'other_income' },
};

const TYPE_CODE_PREFIX: Record<AccountType, number> = {
  asset: 1000,
  liability: 2000,
  equity: 3000,
  revenue: 4000,
  expense: 5000,
};

// ------------------------- Parser -------------------------------------------

export function parseIif(text: string): IifPreview {
  const accounts: ParsedAccount[] = [];
  const customers: ParsedCustomer[] = [];
  const vendors: ParsedVendor[] = [];
  const unrecognizedSections: string[] = [];
  const warnings: string[] = [];
  const seenSections = new Set<string>();

  // Maps section tag -> column index map.
  const headers: Record<string, Record<string, number>> = {};

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (!raw.trim()) continue;
    const cells = raw.split('\t');
    const tag = cells[0] ?? '';

    if (tag.startsWith('!')) {
      // Header row. Build column map for this section.
      const sectionTag = tag.slice(1);
      const colMap: Record<string, number> = {};
      for (let c = 1; c < cells.length; c++) {
        const colName = (cells[c] ?? '').trim();
        if (colName) colMap[colName] = c;
      }
      headers[sectionTag] = colMap;
      continue;
    }

    if (!tag) continue;

    if (tag === 'ACCNT') {
      const cols = headers.ACCNT;
      if (!cols) {
        warnings.push(`row ${i + 1}: ACCNT row before ACCNT header; skipping`);
        continue;
      }
      const account = parseAccountRow(cells, cols, i + 1, warnings);
      if (account) accounts.push(account);
      continue;
    }

    if (tag === 'CUST') {
      const cols = headers.CUST;
      if (!cols) {
        warnings.push(`row ${i + 1}: CUST row before CUST header; skipping`);
        continue;
      }
      const cust = parseCustomerRow(cells, cols, i + 1, warnings);
      if (cust) customers.push(cust);
      continue;
    }

    if (tag === 'VEND') {
      const cols = headers.VEND;
      if (!cols) {
        warnings.push(`row ${i + 1}: VEND row before VEND header; skipping`);
        continue;
      }
      const v = parseVendorRow(cells, cols, i + 1, warnings);
      if (v) vendors.push(v);
      continue;
    }

    // Track unrecognized but valid-looking section tags so the user can see
    // what got dropped (e.g., TRNS, SPL, ENDTRNS, INVITEM, CLASS, EMP).
    if (/^[A-Z][A-Z0-9_]*$/.test(tag)) {
      seenSections.add(tag);
    }
  }

  for (const tag of ['TRNS', 'SPL', 'ENDTRNS', 'INVITEM', 'EMP', 'CLASS', 'TIMEACT']) {
    if (seenSections.has(tag)) {
      const friendly =
        tag === 'TRNS' || tag === 'SPL' || tag === 'ENDTRNS'
          ? 'transactions'
          : tag === 'INVITEM'
            ? 'inventory items'
            : tag === 'EMP'
              ? 'employees'
              : tag === 'CLASS'
                ? 'classes'
                : tag === 'TIMEACT'
                  ? 'time activities'
                  : tag;
      if (!unrecognizedSections.includes(friendly)) unrecognizedSections.push(friendly);
    }
  }

  // Assign suggested codes after all accounts parsed so we can group by type.
  const counters: Record<AccountType, number> = {
    asset: 0,
    liability: 0,
    equity: 0,
    revenue: 0,
    expense: 0,
  };
  for (const a of accounts) {
    counters[a.type]++;
    a.suggestedCode = String(TYPE_CODE_PREFIX[a.type] + counters[a.type] * 10);
  }

  return { accounts, customers, vendors, unrecognizedSections, warnings };
}

function parseAccountRow(
  cells: string[],
  cols: Record<string, number>,
  rowNo: number,
  warnings: string[],
): ParsedAccount | null {
  const cell = (col: string) => (cells[cols[col] ?? -1] ?? '').trim();
  const name = cell('NAME');
  if (!name) {
    warnings.push(`row ${rowNo}: ACCNT row missing NAME; skipping`);
    return null;
  }
  const qbType = cell('ACCNTTYPE') || 'EXP';
  const mapped = ACCNT_TYPE_MAP[qbType];
  if (!mapped) {
    warnings.push(
      `row ${rowNo}: unknown ACCNTTYPE "${qbType}" for "${name}" -- treating as expense`,
    );
  }
  const desc = cell('DESC');
  const final = mapped ?? { type: 'expense' as const, subtype: 'expense' as const };
  return {
    name,
    qbType,
    type: final.type,
    subtype: final.subtype,
    description: desc || undefined,
    suggestedCode: '', // assigned later
  };
}

function parseCustomerRow(
  cells: string[],
  cols: Record<string, number>,
  rowNo: number,
  warnings: string[],
): ParsedCustomer | null {
  const cell = (col: string) => (cells[cols[col] ?? -1] ?? '').trim();
  const name = cell('NAME');
  if (!name) {
    warnings.push(`row ${rowNo}: CUST row missing NAME; skipping`);
    return null;
  }
  // QB IIF often uses PRINTAS for the company name and NAME for the contact.
  const printAs = cell('PRINTAS');
  const note = cell('NOTE');
  const phone = cell('PHONE1');
  const email = cell('EMAIL');
  const terms = cell('TERMS');
  const termsDays = parseTermsToDays(terms);
  return {
    displayName: name,
    companyName: printAs && printAs !== name ? printAs : undefined,
    email: email || undefined,
    phone: phone || undefined,
    notes: note || undefined,
    defaultTermsDays: termsDays,
  };
}

function parseVendorRow(
  cells: string[],
  cols: Record<string, number>,
  rowNo: number,
  warnings: string[],
): ParsedVendor | null {
  const cell = (col: string) => (cells[cols[col] ?? -1] ?? '').trim();
  const name = cell('NAME');
  if (!name) {
    warnings.push(`row ${rowNo}: VEND row missing NAME; skipping`);
    return null;
  }
  const printAs = cell('PRINTAS');
  const note = cell('NOTE');
  const phone = cell('PHONE1');
  const email = cell('EMAIL');
  const terms = cell('TERMS');
  const taxId = cell('TAXID');
  const eligible = cell('VENDOR1099').toUpperCase() === 'Y';
  return {
    displayName: name,
    companyName: printAs && printAs !== name ? printAs : undefined,
    email: email || undefined,
    phone: phone || undefined,
    notes: note || undefined,
    defaultTermsDays: parseTermsToDays(terms),
    is1099Vendor: eligible,
    taxId: taxId || undefined,
  };
}

function parseTermsToDays(terms: string): number | undefined {
  if (!terms) return undefined;
  // Common QB strings: "Net 30", "Net 15", "Due on receipt", "1% 10 Net 30".
  const m = terms.match(/Net\s*(\d+)/i);
  if (m && m[1]) return parseInt(m[1], 10);
  if (/due\s*on\s*receipt/i.test(terms)) return 0;
  return undefined;
}

// ------------------------- Commit -------------------------------------------

const CommitAccount = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  subtype: z.enum([
    'bank',
    'accounts_receivable',
    'other_current_asset',
    'fixed_asset',
    'other_asset',
    'accounts_payable',
    'credit_card',
    'other_current_liability',
    'long_term_liability',
    'equity',
    'retained_earnings',
    'income',
    'other_income',
    'expense',
    'cost_of_goods_sold',
    'other_expense',
  ]),
  code: z.string().min(1).max(40),
  description: z.string().max(500).optional(),
});

const CommitCustomer = z.object({
  displayName: z.string().min(1).max(200),
  companyName: z.string().max(200).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
  defaultTermsDays: z.number().int().min(0).max(365).optional(),
});

const CommitVendor = z.object({
  displayName: z.string().min(1).max(200),
  companyName: z.string().max(200).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
  defaultTermsDays: z.number().int().min(0).max(365).optional(),
  is1099Vendor: z.boolean().default(false),
  taxId: z.string().max(40).optional(),
});

export const CommitIifSchema = z.object({
  accounts: z.array(CommitAccount).default([]),
  customers: z.array(CommitCustomer).default([]),
  vendors: z.array(CommitVendor).default([]),
});

export type CommitIifInput = z.infer<typeof CommitIifSchema>;

export interface CommitResult {
  accountsCreated: number;
  accountsSkipped: number;
  customersCreated: number;
  customersSkipped: number;
  vendorsCreated: number;
  vendorsSkipped: number;
  conflicts: { kind: 'account' | 'customer' | 'vendor'; identifier: string; reason: string }[];
}

export interface CommitContext {
  companyId: string;
  userId: string;
}

/**
 * Skip-on-conflict policy: if a name (or account code) already exists in the
 * company, the row is skipped. The caller sees a count + a list of skipped
 * identifiers so they know what to fix manually. This keeps the import
 * idempotent -- a second run with the same file is a no-op.
 */
export async function commitIifImport(
  tx: Database,
  ctx: CommitContext,
  input: CommitIifInput,
): Promise<CommitResult> {
  const result: CommitResult = {
    accountsCreated: 0,
    accountsSkipped: 0,
    customersCreated: 0,
    customersSkipped: 0,
    vendorsCreated: 0,
    vendorsSkipped: 0,
    conflicts: [],
  };

  // Account conflict detection: by code (unique within company) and by name.
  if (input.accounts.length > 0) {
    const codes = input.accounts.map((a) => a.code);
    const names = input.accounts.map((a) => a.name);
    const existing = await tx
      .select({ code: accountsTable.code, name: accountsTable.name })
      .from(accountsTable)
      .where(
        and(
          eq(accountsTable.companyId, ctx.companyId),
          inArray(accountsTable.code, codes),
        ),
      );
    const existingByCode = new Set(existing.map((r) => r.code));
    const existingByName = new Set(
      (
        await tx
          .select({ name: accountsTable.name })
          .from(accountsTable)
          .where(
            and(
              eq(accountsTable.companyId, ctx.companyId),
              inArray(accountsTable.name, names),
            ),
          )
      ).map((r) => r.name),
    );

    const usedCodesThisImport = new Set<string>();
    for (const a of input.accounts) {
      if (existingByCode.has(a.code) || usedCodesThisImport.has(a.code)) {
        result.accountsSkipped++;
        result.conflicts.push({
          kind: 'account',
          identifier: a.name,
          reason: `code ${a.code} already exists`,
        });
        continue;
      }
      if (existingByName.has(a.name)) {
        result.accountsSkipped++;
        result.conflicts.push({
          kind: 'account',
          identifier: a.name,
          reason: 'name already exists',
        });
        continue;
      }
      await tx.insert(accountsTable).values({
        companyId: ctx.companyId,
        code: a.code,
        name: a.name,
        type: a.type,
        subtype: a.subtype as never,
        currency: 'USD',
        description: a.description ?? null,
      });
      usedCodesThisImport.add(a.code);
      result.accountsCreated++;
    }
  }

  if (input.customers.length > 0) {
    const names = input.customers.map((c) => c.displayName);
    const existing = new Set(
      (
        await tx
          .select({ name: customersTable.displayName })
          .from(customersTable)
          .where(
            and(
              eq(customersTable.companyId, ctx.companyId),
              inArray(customersTable.displayName, names),
            ),
          )
      ).map((r) => r.name),
    );
    for (const c of input.customers) {
      if (existing.has(c.displayName)) {
        result.customersSkipped++;
        result.conflicts.push({
          kind: 'customer',
          identifier: c.displayName,
          reason: 'name already exists',
        });
        continue;
      }
      await tx.insert(customersTable).values({
        companyId: ctx.companyId,
        displayName: c.displayName,
        companyName: c.companyName ?? null,
        email: c.email ?? null,
        phone: c.phone ?? null,
        notes: c.notes ?? null,
        defaultTermsDays: c.defaultTermsDays ?? null,
      });
      result.customersCreated++;
    }
  }

  if (input.vendors.length > 0) {
    const names = input.vendors.map((v) => v.displayName);
    const existing = new Set(
      (
        await tx
          .select({ name: vendorsTable.displayName })
          .from(vendorsTable)
          .where(
            and(
              eq(vendorsTable.companyId, ctx.companyId),
              inArray(vendorsTable.displayName, names),
            ),
          )
      ).map((r) => r.name),
    );
    for (const v of input.vendors) {
      if (existing.has(v.displayName)) {
        result.vendorsSkipped++;
        result.conflicts.push({
          kind: 'vendor',
          identifier: v.displayName,
          reason: 'name already exists',
        });
        continue;
      }
      // 1099 invariant: tax ID required when flagged.
      if (v.is1099Vendor && !(v.taxId && v.taxId.length > 0)) {
        result.vendorsSkipped++;
        result.conflicts.push({
          kind: 'vendor',
          identifier: v.displayName,
          reason: '1099 vendor without tax ID -- skipped (add manually)',
        });
        continue;
      }
      await tx.insert(vendorsTable).values({
        companyId: ctx.companyId,
        displayName: v.displayName,
        companyName: v.companyName ?? null,
        email: v.email ?? null,
        phone: v.phone ?? null,
        notes: v.notes ?? null,
        defaultTermsDays: v.defaultTermsDays ?? null,
        is1099Vendor: v.is1099Vendor,
        taxId: v.taxId ?? null,
      });
      result.vendorsCreated++;
    }
  }

  return result;
}
