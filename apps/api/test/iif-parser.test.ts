/**
 * IIF parser: pure function tests, no DB. Verifies header-driven column
 * mapping, ACCNTTYPE -> KPBooks subtype mapping, terms parsing, 1099 flag,
 * and the unrecognized-section reporting.
 */
import { describe, expect, it } from 'vitest';
import { CommitIifSchema, parseIif, splitIifLine } from '../src/modules/imports/iif.js';

const t = '\t';

/** type/subtype of a parsed account, for readable per-name assertions. */
const pick = (a: { type: string; subtype: string }) => ({ type: a.type, subtype: a.subtype });

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

  it('warns when ACCNTTYPE is blank or absent instead of silently defaulting to expense', () => {
    // A tool-converted file can lack the ACCNTTYPE column entirely, and a
    // truncated row can leave the cell empty. Both used to take the EXP
    // default with zero warnings, so a bank account imported as an expense
    // account and cash quietly left the balance sheet for the P&L.
    const noColumn = parseIif([`!ACCNT${t}NAME`, `ACCNT${t}Chase Checking`].join('\n'));
    expect(noColumn.accounts).toHaveLength(1);
    expect(noColumn.accounts[0]?.type).toBe('expense');
    expect(
      noColumn.warnings.some(
        (w) => /Chase Checking/.test(w) && /no ACCNTTYPE/.test(w) && /treating as expense/.test(w),
      ),
    ).toBe(true);

    const truncatedRow = parseIif(
      [`!ACCNT${t}NAME${t}ACCNTTYPE`, `ACCNT${t}Chase Checking`].join('\n'),
    );
    expect(truncatedRow.accounts).toHaveLength(1);
    expect(truncatedRow.warnings.some((w) => /no ACCNTTYPE/.test(w))).toBe(true);

    // A populated ACCNTTYPE stays warning-free.
    const normal = parseIif(
      [`!ACCNT${t}NAME${t}ACCNTTYPE`, `ACCNT${t}Chase Checking${t}BANK`].join('\n'),
    );
    expect(normal.warnings).toEqual([]);
  });

  it('maps ACCNTTYPE case-insensitively (hand-edited "Bank" is a bank account, not an expense)', () => {
    // Real QBD exports emit uppercase keywords, but conversion tools and
    // hand-edited files carry "Bank"/"Ccard". A raw-cased map lookup fell
    // through to expense/expense, moving the bank account onto the P&L with
    // only a warning.
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE`,
      `ACCNT${t}Checking${t}Bank`,
      `ACCNT${t}Visa${t}ccard`,
      `ACCNT${t}No More Estimates${t}NonPosting`,
    ].join('\n');
    const out = parseIif(text);
    const checking = out.accounts.find((a) => a.name === 'Checking')!;
    expect(checking.type).toBe('asset');
    expect(checking.subtype).toBe('bank');
    expect(checking.qbType).toBe('BANK'); // stored uppercased, like TRNSTYPE
    const visa = out.accounts.find((a) => a.name === 'Visa')!;
    expect(visa.type).toBe('liability');
    expect(visa.subtype).toBe('credit_card');
    // NONPOSTING check is case-insensitive too: the row is skipped entirely.
    expect(out.accounts.find((a) => a.name === 'No More Estimates')).toBeUndefined();
    expect(out.warnings.some((w) => /unknown ACCNTTYPE/.test(w))).toBe(false);
  });

  it('gives Retained Earnings the retained_earnings subtype even though QBD emits plain EQUITY', () => {
    // IIF has no distinct code for Retained Earnings -- QBD writes EQUITY --
    // but the subtype is load-bearing: the statement of cash flows skips
    // retained_earnings (already counted via net income) while plain `equity`
    // lands in financing. The transactions-only path infers it from the name,
    // so without this the same account gets two different subtypes depending
    // on which file the customer imported first, and account type/subtype
    // cannot be edited after posting.
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE`,
      `ACCNT${t}Retained Earnings${t}EQUITY`,
      `ACCNT${t}Owner's Equity:Retained Earnings${t}EQUITY`,
      `ACCNT${t}Retained Earnings - Prior Years${t}EQUITY`,
      `ACCNT${t}Owner's Equity${t}EQUITY`,
      `ACCNT${t}Owner's Draw${t}EQUITY`,
    ].join('\n');
    const out = parseIif(text);
    const byName = new Map(out.accounts.map((a) => [a.name, a]));
    for (const name of [
      'Retained Earnings',
      "Owner's Equity:Retained Earnings",
      'Retained Earnings - Prior Years',
    ]) {
      expect({ name, ...pick(byName.get(name)!) }).toEqual({
        name,
        type: 'equity',
        subtype: 'retained_earnings',
      });
    }
    // Every other equity account keeps the plain equity subtype.
    for (const name of ["Owner's Equity", "Owner's Draw"]) {
      expect({ name, ...pick(byName.get(name)!) }).toEqual({
        name,
        type: 'equity',
        subtype: 'equity',
      });
    }
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

  it('preserves QBD account numbers (ACCNUM) instead of renumbering the chart', () => {
    // Real QBD !ACCNT header shape -- ACCNUM carries the customer's own
    // numbering scheme, which CPAs cross-reference against old workpapers.
    const text = [
      `!ACCNT${t}NAME${t}REFNUM${t}TIMESTAMP${t}ACCNTTYPE${t}OBAMOUNT${t}DESC${t}ACCNUM${t}SCD${t}BANKNUM${t}EXTRA${t}HIDDEN${t}DELCOUNT`,
      `ACCNT${t}Checking${t}1${t}${t}BANK${t}0.00${t}${t}10100${t}${t}${t}${t}N${t}0`,
      `ACCNT${t}Job Materials${t}2${t}${t}COGS${t}0.00${t}${t}50100${t}${t}${t}${t}N${t}0`,
      `ACCNT${t}Sales${t}3${t}${t}INC${t}0.00${t}${t}${t}${t}${t}${t}N${t}0`,
    ].join('\n');
    const out = parseIif(text);
    const codes = Object.fromEntries(out.accounts.map((a) => [a.name, a.suggestedCode]));
    expect(codes.Checking).toBe('10100');
    expect(codes['Job Materials']).toBe('50100');
    // No ACCNUM -> synthetic code, as before.
    expect(codes.Sales).toBe('4010');
  });

  it('synthetic codes step over ACCNUM codes already used in the file', () => {
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE${t}ACCNUM`,
      `ACCNT${t}Cash${t}BANK${t}1010`,
      `ACCNT${t}Savings${t}BANK${t}`,
    ].join('\n');
    const out = parseIif(text);
    const codes = Object.fromEntries(out.accounts.map((a) => [a.name, a.suggestedCode]));
    expect(codes.Cash).toBe('1010');
    // 1010 is taken by the file's own ACCNUM; the synthetic pass skips it.
    expect(codes.Savings).toBe('1020');
  });

  it('reads the 1099 flag from the real QBD column name "1099"', () => {
    const text = [
      `!VEND${t}NAME${t}PRINTAS${t}ADDR1${t}TAXID${t}1099${t}HIDDEN`,
      `VEND${t}Joe Subcontractor${t}${t}${t}12-3456789${t}Y${t}N`,
      `VEND${t}Utility Co${t}${t}${t}${t}N${t}N`,
    ].join('\n');
    const out = parseIif(text);
    const joe = out.vendors.find((v) => v.displayName === 'Joe Subcontractor')!;
    expect(joe.is1099Vendor).toBe(true);
    expect(joe.taxId).toBe('12-3456789');
    const util = out.vendors.find((v) => v.displayName === 'Utility Co')!;
    expect(util.is1099Vendor).toBe(false);
  });

  it('imports the HIDDEN flag: HIDDEN=Y rows arrive inactive, everything else active', () => {
    // Real QBD lists exports mark inactive records with HIDDEN=Y. A 15-year
    // company file routinely carries hundreds of retired accounts/vendors;
    // importing them active floods pickers and accepts new postings to
    // accounts the CPA deliberately closed.
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE${t}HIDDEN`,
      `ACCNT${t}Old Checking${t}BANK${t}Y`,
      `ACCNT${t}Checking${t}BANK${t}N`,
      `ACCNT${t}Sales${t}INC${t}`, // absent/blank -> active
      `!CUST${t}NAME${t}HIDDEN`,
      `CUST${t}Defunct Customer${t}Y`,
      `CUST${t}Acme${t}N`,
      `!VEND${t}NAME${t}1099${t}HIDDEN`,
      `VEND${t}Closed Vendor${t}N${t}Y`,
      `VEND${t}Office Supply${t}N${t}N`,
    ].join('\n');
    const out = parseIif(text);
    const active = Object.fromEntries(out.accounts.map((a) => [a.name, a.isActive]));
    expect(active).toEqual({ 'Old Checking': false, Checking: true, Sales: true });
    expect(out.customers.find((c) => c.displayName === 'Defunct Customer')?.isActive).toBe(false);
    expect(out.customers.find((c) => c.displayName === 'Acme')?.isActive).toBe(true);
    expect(out.vendors.find((v) => v.displayName === 'Closed Vendor')?.isActive).toBe(false);
    expect(out.vendors.find((v) => v.displayName === 'Office Supply')?.isActive).toBe(true);
  });

  it('warns at preview when transactions reference a HIDDEN account (they will be skipped at commit)', () => {
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE${t}HIDDEN`,
      `ACCNT${t}Old Checking${t}BANK${t}Y`,
      `ACCNT${t}Office Expense${t}EXP${t}N`,
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}2019-06-01${t}Old Checking${t}-75.00`,
      `SPL${t}CHECK${t}2019-06-01${t}Office Expense${t}75.00`,
      `ENDTRNS`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.warnings.some((w) => /inactive \(HIDDEN=Y\)/.test(w) && /1 transaction/.test(w))).toBe(
      true,
    );
  });

  it('parses vendor ADDR1-5 (the real QBD !VEND header) into a structured mailing address (1099s need it)', () => {
    // Real QBD lists exports carry the vendor mailing address in ADDR1-5 --
    // BADDR/SADDR belong to the !CUST section. Reading only BADDR silently
    // dropped every vendor address in a genuine export, then warned that
    // each 1099 vendor "has no mailing address".
    const text = [
      `!VEND${t}NAME${t}REFNUM${t}TIMESTAMP${t}PRINTAS${t}ADDR1${t}ADDR2${t}ADDR3${t}ADDR4${t}ADDR5${t}VTYPE${t}CONT1${t}PHONE1${t}TAXID${t}LIMIT${t}TERMS${t}NOTEPAD${t}SALUTATION${t}COMPANYNAME${t}FIRSTNAME${t}LASTNAME${t}1099${t}HIDDEN${t}DELCOUNT`,
      `VEND${t}Joe Subcontractor${t}1${t}${t}Joe Subcontractor${t}Joe Subcontractor${t}123 Main St${t}Suite 4${t}Austin, TX 78701${t}${t}Subcontractor${t}${t}555-9876${t}12-3456789${t}${t}Net 30${t}${t}${t}${t}${t}${t}Y${t}N${t}0`,
    ].join('\n');
    const out = parseIif(text);
    const joe = out.vendors.find((v) => v.displayName === 'Joe Subcontractor')!;
    expect(joe.is1099Vendor).toBe(true);
    // ADDR1 duplicates the vendor name -> dropped; last line -> city/state/ZIP.
    expect(joe.mailingAddress).toEqual({
      street1: '123 Main St',
      street2: 'Suite 4',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
    });
  });

  it('falls back to vendor BADDR1-5 for hand-built files without ADDR columns', () => {
    const text = [
      `!VEND${t}NAME${t}PRINTAS${t}BADDR1${t}BADDR2${t}BADDR3${t}BADDR4${t}BADDR5${t}TAXID${t}1099${t}HIDDEN`,
      `VEND${t}Joe Subcontractor${t}${t}Joe Subcontractor${t}123 Main St${t}Suite 4${t}Austin, TX 78701${t}${t}12-3456789${t}Y${t}N`,
    ].join('\n');
    const out = parseIif(text);
    const joe = out.vendors.find((v) => v.displayName === 'Joe Subcontractor')!;
    // BADDR1 duplicates the vendor name -> dropped; last line -> city/state/ZIP.
    expect(joe.mailingAddress).toEqual({
      street1: '123 Main St',
      street2: 'Suite 4',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
    });
  });

  it('parses customer BADDR (billing) and SADDR (shipping) blocks', () => {
    const text = [
      `!CUST${t}NAME${t}BADDR1${t}BADDR2${t}BADDR3${t}SADDR1${t}SADDR2${t}HIDDEN`,
      `CUST${t}Acme Corp${t}Acme Corp${t}500 Elm St${t}Dallas, TX 75201${t}12 Warehouse Rd${t}Plano, TX 75093-1234${t}N`,
    ].join('\n');
    const out = parseIif(text);
    const acme = out.customers[0]!;
    expect(acme.billingAddress).toEqual({
      street1: '500 Elm St',
      city: 'Dallas',
      state: 'TX',
      postalCode: '75201',
    });
    expect(acme.shippingAddress).toEqual({
      street1: '12 Warehouse Rd',
      city: 'Plano',
      state: 'TX',
      postalCode: '75093-1234',
    });
    // No address columns at all -> undefined, not an empty object.
    const out2 = parseIif([`!CUST${t}NAME`, `CUST${t}Bare`].join('\n'));
    expect(out2.customers[0]?.billingAddress).toBeUndefined();
  });

  it('keeps unparseable address lines in the street fields instead of dropping them', () => {
    const text = [
      `!VEND${t}NAME${t}BADDR1${t}BADDR2`,
      `VEND${t}Intl Vendor${t}42 Rue de la Paix${t}75002 Paris CEDEX`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.vendors[0]?.mailingAddress).toEqual({
      street1: '42 Rue de la Paix',
      street2: '75002 Paris CEDEX',
    });
  });

  it('degrades terms beyond Net 365 to no-default-terms with a warning instead of 400ing the commit', () => {
    // QBD terms are user-defined free text ("Net 400" is legal there); the
    // commit schema caps defaultTermsDays at 365, so an unclamped value
    // previewed clean and then rejected the ENTIRE lists commit.
    const text = [
      `!VEND${t}NAME${t}TERMS`,
      `VEND${t}Slow Pay Vendor${t}Net 400`,
      `VEND${t}Normal Vendor${t}Net 30`,
      `!CUST${t}NAME${t}TERMS`,
      `CUST${t}Slow Pay Customer${t}Net 730`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.vendors.find((v) => v.displayName === 'Slow Pay Vendor')?.defaultTermsDays).toBeUndefined();
    expect(out.vendors.find((v) => v.displayName === 'Normal Vendor')?.defaultTermsDays).toBe(30);
    expect(out.customers[0]?.defaultTermsDays).toBeUndefined();
    expect(out.warnings.filter((w) => /exceed Net 365/.test(w))).toHaveLength(2);
  });

  it('strips a leading BOM (raw U+FEFF and windows-1252 mojibake)', () => {
    const body = [`!ACCNT${t}NAME${t}ACCNTTYPE`, `ACCNT${t}Cash${t}BANK`].join('\r\n');
    for (const bom of [String.fromCharCode(0xfeff), 'ï»¿']) {
      const out = parseIif(bom + body);
      expect(out.accounts, JSON.stringify(out.warnings)).toHaveLength(1);
      expect(out.accounts[0]?.name).toBe('Cash');
      expect(out.warnings).toEqual([]);
    }
  });

  it('handles lone-CR line endings without leaking \\r into cells', () => {
    const text = `!ACCNT${t}NAME${t}ACCNTTYPE\rACCNT${t}Cash${t}BANK\r`;
    const out = parseIif(text);
    expect(out.accounts).toHaveLength(1);
    expect(out.accounts[0]?.name).toBe('Cash');
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

  it('reports OTHERNAME, TERMS, and unknown sections as skipped -- nothing drops silently', () => {
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE`,
      `ACCNT${t}Checking${t}BANK`,
      `!OTHERNAME${t}NAME${t}BADDR1`,
      `OTHERNAME${t}County Clerk${t}`,
      `OTHERNAME${t}Owner Draw${t}`,
      `!TERMS${t}NAME${t}DUEDAYS`,
      `TERMS${t}Net 30${t}30`,
      `!PAYMETH${t}NAME`,
      `PAYMETH${t}Check`,
      `!SOMENEWTAG${t}NAME`,
      `SOMENEWTAG${t}whatever`,
    ].join('\n');
    const out = parseIif(text);
    expect(out.unrecognizedSections).toContain('other names');
    expect(out.unrecognizedSections).toContain('payment terms');
    expect(out.unrecognizedSections).toContain('payment methods');
    // Unknown tags pass through raw so even future QBD sections are visible.
    expect(out.unrecognizedSections).toContain('SOMENEWTAG');
  });

  it('silently ignores the !HDR/HDR metadata section instead of reporting it as skipped data', () => {
    // Every real QBD transaction export begins with !HDR + one HDR row of
    // PROD/VER/REL/IIFVER file metadata. It carries no records, so surfacing
    // it in unrecognizedSections rendered "Skipped (not yet supported): HDR"
    // on every genuine export -- implying records were dropped and prompting
    // needless support calls.
    const text = [
      `!HDR${t}PROD${t}VER${t}REL${t}IIFVER${t}DATE${t}TIME${t}ACCNTNT${t}ACCNTNTSPLITTIME`,
      `HDR${t}QuickBooks Pro${t}Version 2019 (R5P)${t}Release R5P${t}1${t}08/11/2026${t}1723400000${t}N${t}0`,
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}2026-02-01${t}Checking${t}-75.00`,
      `SPL${t}CHECK${t}2026-02-01${t}Office Expense${t}75.00`,
      `ENDTRNS`,
    ].join('\r\n');
    const out = parseIif(text);
    expect(out.unrecognizedSections).toEqual([]);
    expect(out.transactions).toHaveLength(1); // nothing else disturbed
    expect(out.warnings).toEqual([]);
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

  it('recovers every column after an unterminated quote instead of swallowing the row', () => {
    // A stray opening quote in a free-text field (a bookkeeper typing
    // `"see attached W-9`, or an Excel/Notepad round-trip) used to make the
    // whole rest of the LINE one cell: the row still "parsed", so the vendor
    // arrived with no 1099 flag, no TIN and no terms, warnings was empty, and
    // the vendor silently dropped out of the January 1099-NEC run.
    const header = `!VEND${t}NAME${t}ADDR1${t}NOTE${t}TAXID${t}TERMS${t}1099${t}HIDDEN`;
    const row = `VEND${t}Joe Sub${t}123 Main${t}"called re invoice${t}12-3456789${t}Net 30${t}Y${t}N`;
    // The splitter itself must keep all 8 columns.
    expect(splitIifLine(row)).toHaveLength(8);

    const out = parseIif([header, row].join('\r\n'));
    const v = out.vendors[0]!;
    expect(v.displayName).toBe('Joe Sub');
    expect(v.is1099Vendor).toBe(true);
    expect(v.taxId).toBe('12-3456789');
    expect(v.defaultTermsDays).toBe(30);
    // ...and the malformed quoting is disclosed rather than passing clean.
    expect(out.warnings.some((w) => /row 2/.test(w) && /unterminated quote/.test(w))).toBe(true);

    // Same shape on the real QBD !ACCNT header: HIDDEN and ACCNUM sit AFTER
    // DESC, so both were lost -- a QBD-inactive account imported active with
    // an invented account code, and a description full of raw tabs.
    const accnt = parseIif(
      [
        `!ACCNT${t}NAME${t}REFNUM${t}TIMESTAMP${t}ACCNTTYPE${t}OBAMOUNT${t}DESC${t}ACCNUM${t}SCD${t}BANKNUM${t}EXTRA${t}HIDDEN${t}DELCOUNT`,
        `ACCNT${t}Old Truck Loan${t}7${t}${t}LTLIAB${t}0.00${t}"paid off 2019${t}27100${t}${t}${t}${t}Y${t}0`,
      ].join('\r\n'),
    );
    const a = accnt.accounts[0]!;
    expect(a.isActive).toBe(false);
    expect(a.suggestedCode).toBe('27100');
    expect(a.description).toContain('paid off 2019');
    expect(a.description).not.toContain('\t');
    expect(accnt.warnings.some((w) => /unterminated quote/.test(w))).toBe(true);
  });

  it('still honours a properly closed quoted field containing tabs and "" escapes', () => {
    // Guard for the recovery above: a WELL-FORMED quoted field must keep its
    // embedded tab as data, not be re-split into columns.
    const cells = splitIifLine(`ACCNT${t}"Repairs\tand Maintenance"${t}"He said ""hi"""${t}EXP`);
    expect(cells).toEqual(['ACCNT', `Repairs${t}and Maintenance`, 'He said "hi"', 'EXP']);
  });

  it('discloses rows whose tag is not a section tag, and reads tags with stray whitespace', () => {
    // Hand-edited and tool-converted files carry leading spaces and
    // lower-cased tags. Those rows used to be dropped with no warning and no
    // "skipped" entry -- the exact silent loss this module promises never to
    // do. Note the "Skipped (not yet supported)" list must NOT fill up with
    // junk like "Total assets": that would be its own lie.
    const text = [
      `!ACCNT${t}NAME${t}ACCNTTYPE`,
      `ACCNT${t}Checking${t}BANK`,
      ` ACCNT${t}Savings${t}BANK`,
      `accnt${t}Petty Cash${t}BANK`,
      `accnt${t}Cash Drawer${t}BANK`,
      `Total assets${t}12345`,
    ].join('\r\n');
    const out = parseIif(text);
    // The whitespace-padded tag is now recognised and imports.
    expect(out.accounts.map((a) => a.name)).toEqual(['Checking', 'Savings']);
    expect(out.unrecognizedSections).toEqual([]);
    // One aggregated warning per distinct unknown tag (not one per row, so a
    // whole-file corruption stays readable).
    const lower = out.warnings.find((w) => /"accnt"/.test(w))!;
    expect(lower).toMatch(/unrecognized row type/);
    expect(lower).toMatch(/2 row\(s\)/);
    expect(lower).toMatch(/first at row 4/);
    expect(out.warnings.some((w) => /"Total assets"/.test(w))).toBe(true);
  });

  it('counts a TRNS block that precedes its !TRNS header instead of under-reporting the file', () => {
    // A hand-trimmed or spliced transactions export can put data rows ahead
    // of the header. The block cannot post -- but a free-text warning alone
    // left the preview's per-type table and the completion screen reading
    // "1 CHECK, 0 skipped, 0 excluded" for a file holding TWO checks, so the
    // bank register came up short with nothing accounting for it.
    const text = [
      `TRNS${t}CHECK${t}5/1/2026${t}Checking${t}-100.00`,
      `SPL${t}CHECK${t}5/1/2026${t}Office Expense${t}100.00`,
      `ENDTRNS`,
      `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
      `!ENDTRNS`,
      `TRNS${t}CHECK${t}5/2/2026${t}Checking${t}-200.00`,
      `SPL${t}CHECK${t}5/2/2026${t}Office Expense${t}200.00`,
      `ENDTRNS`,
    ].join('\r\n');
    const out = parseIif(text);
    expect(out.transactions).toHaveLength(1);
    // Both blocks are accounted for: one posted, one excluded as UNKNOWN
    // (without the header the TRNSTYPE column position is unknowable).
    expect(out.transactionCounts).toEqual({ CHECK: 1, UNKNOWN: 1 });
    expect(out.excludedTransactions).toHaveLength(1);
    expect(out.excludedTransactions[0]).toMatchObject({ rowNumber: 1, qbType: 'UNKNOWN' });
    expect(out.excludedTransactions[0]?.reason).toMatch(/before its !TRNS header/);
    expect(out.warnings.some((w) => /TRNS row before TRNS header/.test(w))).toBe(true);
  });

  it('tells the user a lists-only file leaves QBD opening balances behind', () => {
    // OBAMOUNT is deliberately never imported (QuickBooks records opening
    // balances as real transactions, so importing the column too would
    // double-book them) -- but a customer who runs only the documented first
    // step, File > Utilities > Export > Lists to IIF, otherwise gets a
    // complete chart, zero warnings, and no hint that the balances are still
    // sitting in the other file.
    const header = `!ACCNT${t}NAME${t}REFNUM${t}TIMESTAMP${t}ACCNTTYPE${t}OBAMOUNT${t}DESC${t}ACCNUM${t}SCD${t}BANKNUM${t}EXTRA${t}HIDDEN${t}DELCOUNT`;
    const withBalances = parseIif(
      [
        header,
        `ACCNT${t}Checking${t}1${t}${t}BANK${t}18,450.22${t}${t}10100${t}${t}${t}${t}N${t}0`,
        `ACCNT${t}Sales${t}2${t}${t}INC${t}0.00${t}${t}${t}${t}${t}${t}N${t}0`,
      ].join('\r\n'),
    );
    const note = withBalances.warnings.find((w) => /opening balance/i.test(w))!;
    expect(note).toBeTruthy();
    expect(note).toMatch(/1 account\(s\)/);
    expect(note).toMatch(/transactions IIF export/);

    // No noise on the common case: a lists file whose balances are all zero
    // (QBD writes 0.00 for accounts opened through transactions) says nothing.
    const allZero = parseIif(
      [
        header,
        `ACCNT${t}Checking${t}1${t}${t}BANK${t}0.00${t}${t}10100${t}${t}${t}${t}N${t}0`,
      ].join('\r\n'),
    );
    expect(allZero.warnings).toEqual([]);
  });
});

describe('parseIif over-long contact fields', () => {
  // CommitCustomer/CommitVendor cap phone and taxId at 40 chars. An
  // over-cap value used to sail through preview with ZERO warnings and then
  // throw a ZodError at commit, which the API turns into a 400 for the WHOLE
  // 500-row chunk -- and because the lists leg runs before the transactions
  // leg, that killed the transactions import entirely, identically on every
  // retry, reporting a chunk-relative path ("customers.37.phone") the user
  // could not map back to a file row.
  const longPhone = '(512) 555-1234 ext. 4471 / cell (512) 555-9999';
  const longTaxId = '12-3456789 (per W-9 received 2025-11-02, see file)';

  it('truncates phone/taxId with a warning instead of 400ing the whole commit', () => {
    const text = [
      `!CUST${t}NAME${t}PHONE1${t}EMAIL`,
      `CUST${t}Smith Construction${t}${longPhone}${t}ap@smith.example`,
      `!VEND${t}NAME${t}PHONE1${t}TAXID${t}1099`,
      `VEND${t}Joe Subcontractor${t}${longPhone}${t}${longTaxId}${t}Y`,
    ].join('\r\n');
    const out = parseIif(text);

    expect(out.customers[0]?.phone).toHaveLength(40);
    expect(out.customers[0]?.phone).toBe(longPhone.slice(0, 40));
    expect(out.vendors[0]?.phone).toHaveLength(40);
    expect(out.vendors[0]?.taxId).toHaveLength(40);
    // Truncating a 1099 vendor's TIN silently would be worse than not
    // importing it, so every truncation is disclosed at preview.
    expect(out.warnings.filter((w) => /truncated/.test(w))).toHaveLength(3);
    expect(out.warnings.some((w) => /customer "Smith Construction" phone/.test(w))).toBe(true);
    expect(out.warnings.some((w) => /vendor "Joe Subcontractor" tax ID/.test(w))).toBe(true);

    // The whole point: the preview payload now survives the commit schema.
    const parsed = CommitIifSchema.safeParse({
      accounts: [],
      customers: out.customers,
      vendors: out.vendors,
    });
    expect(parsed.success).toBe(true);
  });

  it('leaves normal-length values (and their warning list) untouched', () => {
    const out = parseIif(
      [
        `!CUST${t}NAME${t}PHONE1`,
        `CUST${t}Acme Corp${t}(512) 555-1234`,
        `!VEND${t}NAME${t}PHONE1${t}TAXID`,
        `VEND${t}Joe Subcontractor${t}555-9876${t}12-3456789`,
      ].join('\r\n'),
    );
    expect(out.customers[0]?.phone).toBe('(512) 555-1234');
    expect(out.vendors[0]?.taxId).toBe('12-3456789');
    expect(out.warnings).toEqual([]);
  });
});

describe('parseIif rows with an empty first column', () => {
  it('discloses a data row whose section tag is missing instead of dropping it', () => {
    // A spreadsheet round-trip (the Excel/Notepad edit this parser already
    // accommodates elsewhere) can shift a row one column left. The row still
    // carries real content -- a line of nothing but tabs is consumed by the
    // blank-line guard -- so dropping it silently left the customer with a
    // clean, zero-warning preview and an account simply gone from the chart,
    // surfacing much later as per-row "account not found" commit failures.
    const out = parseIif(
      [
        `!ACCNT${t}NAME${t}ACCNTTYPE${t}ACCNUM`,
        `ACCNT${t}Checking${t}BANK${t}1010`,
        `${t}Savings${t}BANK${t}1020`,
      ].join('\r\n'),
    );
    expect(out.accounts.map((a) => a.name)).toEqual(['Checking']);
    const note = out.warnings.find((w) => /empty first column/.test(w));
    expect(note).toBeTruthy();
    expect(note).toMatch(/1 row\(s\)/);
    expect(note).toMatch(/first at row 3/);
  });

  it('aggregates repeats into one warning and stays silent on blank lines', () => {
    const out = parseIif(
      [
        `!ACCNT${t}NAME${t}ACCNTTYPE`,
        `ACCNT${t}Checking${t}BANK`,
        '',
        `${t}${t}`,
        `   `,
        `${t}Savings${t}BANK`,
        `${t}Payroll Account${t}BANK`,
      ].join('\r\n'),
    );
    const notes = out.warnings.filter((w) => /empty first column/.test(w));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/2 row\(s\)/);
    expect(notes[0]).toMatch(/first at row 6/);
  });
});
