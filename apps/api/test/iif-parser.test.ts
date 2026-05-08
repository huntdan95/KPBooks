/**
 * IIF parser: pure function tests, no DB. Verifies header-driven column
 * mapping, ACCNTTYPE -> KPBooks subtype mapping, terms parsing, 1099 flag,
 * and the unrecognized-section reporting.
 */
import { describe, expect, it } from 'vitest';
import { parseIif } from '../src/modules/imports/iif.js';

const t = '\t';

describe('parseIif', () => {
  it('parses a simple ACCNT section with mixed types', () => {
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE${t}DESC`,
      `ACCNT${t}Checking${t}BANK${t}Main checking`,
      `ACCNT${t}Accounts Receivable${t}AR${t}`,
      `ACCNT${t}Sales${t}INC${t}Service revenue`,
      `ACCNT${t}Office Expense${t}EXP${t}`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.accounts).toHaveLength(4);

    const checking = out.accounts.find((a) => a.name === 'Checking');
    expect(checking?.type).toBe('asset');
    expect(checking?.subtype).toBe('bank');
    expect(checking?.qbType).toBe('BANK');
    expect(checking?.description).toBe('Main checking');

    const ar = out.accounts.find((a) => a.name === 'Accounts Receivable');
    expect(ar?.subtype).toBe('accounts_receivable');

    const sales = out.accounts.find((a) => a.name === 'Sales');
    expect(sales?.type).toBe('revenue');
    expect(sales?.subtype).toBe('income');

    const expense = out.accounts.find((a) => a.name === 'Office Expense');
    expect(expense?.type).toBe('expense');
  });

  it('assigns suggested codes per type group', () => {
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE`,
      `ACCNT${t}Cash${t}BANK`,
      `ACCNT${t}Sales${t}INC`,
      `ACCNT${t}Equipment${t}FIXASSET`,
      `ACCNT${t}Rent${t}EXP`,
    ].join('\n');
    const out = parseIif(text);
    const codes = Object.fromEntries(out.accounts.map((a) => [a.name, a.suggestedCode]));
    expect(codes.Cash).toBe('1010');
    expect(codes.Equipment).toBe('1020');
    expect(codes.Sales).toBe('4010');
    expect(codes.Rent).toBe('5010');
  });

  it('falls back to expense + warns on unknown ACCNTTYPE', () => {
    const text = [`!ACCNT${t}NAME${t}ACCNTTYPE`, `ACCNT${t}Mystery${t}WTF`].join('\n');
    const out = parseIif(text);
    expect(out.accounts[0]?.type).toBe('expense');
    expect(out.accounts[0]?.subtype).toBe('expense');
    expect(out.warnings.some((w) => /WTF/.test(w))).toBe(true);
  });

  it('parses CUST + VEND sections with terms and 1099 flag', () => {
    const text = [
      `!CUST${t}NAME${t}PRINTAS${t}EMAIL${t}PHONE1${t}TERMS${t}NOTE`,
      `CUST${t}Acme${t}Acme Corp${t}ap@acme.com${t}555-1234${t}Net 30${t}good payer`,
      `!VEND${t}NAME${t}PRINTAS${t}TERMS${t}TAXID${t}VENDOR1099${t}NOTE`,
      `VEND${t}Office Supply${t}Office Supply Co${t}Net 15${t}12-3456789${t}Y${t}weekly delivery`,
      `VEND${t}Cleaning Crew${t}${t}Due on receipt${t}${t}N${t}`,
    ].join('\n');
    const out = parseIif(text);

    expect(out.customers).toHaveLength(1);
    const c = out.customers[0]!;
    expect(c.displayName).toBe('Acme');
    expect(c.companyName).toBe('Acme Corp');
    expect(c.email).toBe('ap@acme.com');
    expect(c.phone).toBe('555-1234');
    expect(c.defaultTermsDays).toBe(30);
    expect(c.notes).toBe('good payer');

    expect(out.vendors).toHaveLength(2);
    const v1 = out.vendors.find((v) => v.displayName === 'Office Supply')!;
    expect(v1.is1099Vendor).toBe(true);
    expect(v1.taxId).toBe('12-3456789');
    expect(v1.defaultTermsDays).toBe(15);

    const v2 = out.vendors.find((v) => v.displayName === 'Cleaning Crew')!;
    expect(v2.is1099Vendor).toBe(false);
    expect(v2.defaultTermsDays).toBe(0); // Due on receipt
    // PRINTAS empty -> companyName undefined
    expect(v2.companyName).toBeUndefined();
  });

  it('reports unrecognized section types (INVITEM, EMP, CLASS) so users know what was skipped', () => {
    // Transactions are now handled (slice #11) so they don't appear here. Other
    // sections we still don't import surface in unrecognizedSections.
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE`,
      `ACCNT${t}Checking${t}BANK`,
      `!INVITEM${t}NAME${t}INVITEMTYPE`,
      `INVITEM${t}Widget${t}SERV`,
      `!CLASS${t}NAME`,
      `CLASS${t}Department A`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.accounts).toHaveLength(1);
    expect(out.unrecognizedSections).toContain('inventory items');
    expect(out.unrecognizedSections).toContain('classes');
  });

  it('skips data rows that appear before their header', () => {
    const text = [
      // ACCNT row before any !ACCNT header.
      `ACCNT${t}Cash${t}BANK`,
      `!CUST${t}NAME`,
      `CUST${t}Acme`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.accounts).toHaveLength(0);
    expect(out.customers).toHaveLength(1);
    expect(out.warnings.some((w) => /ACCNT row before/.test(w))).toBe(true);
  });

  it('handles CRLF line endings', () => {
    const text = `!ACCNT${t}NAME${t}ACCNTTYPE\r\nACCNT${t}Cash${t}BANK\r\n`;
    const out = parseIif(text);
    expect(out.accounts).toHaveLength(1);
    expect(out.accounts[0]?.name).toBe('Cash');
  });

  it('skips ACCNT rows missing NAME', () => {
    const text = [`!ACCNT${t}NAME${t}ACCNTTYPE`, `ACCNT${t}${t}BANK`].join('\n');
    const out = parseIif(text);
    expect(out.accounts).toHaveLength(0);
    expect(out.warnings.some((w) => /missing NAME/.test(w))).toBe(true);
  });
});
