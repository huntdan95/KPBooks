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
});
