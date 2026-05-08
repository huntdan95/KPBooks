import { describe, expect, it } from 'vitest';
import {
  preflight1099NEC,
  render1099NEC,
  render1099NECCopies,
} from '../src/modules/forms/1099-nec.js';

const completePayer = {
  name: 'KPBooks Test Co',
  ein: '12-3456789',
  address: {
    street1: '100 Main St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
  },
  phone: '512-555-0100',
};

const completeRecipient = {
  displayName: 'Jane Contractor',
  taxId: '123-45-6789',
  mailingAddress: {
    street1: '200 Elm St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78702',
  },
};

describe('preflight1099NEC', () => {
  it('passes with complete data and W-9 on file and amount over $600', () => {
    const issues = preflight1099NEC({
      payer: completePayer,
      recipient: completeRecipient,
      hasW9: true,
      nonemployeeCompensation: '5000',
    });
    expect(issues).toEqual([]);
  });

  it('flags missing W-9 (warning, not blocker)', () => {
    const issues = preflight1099NEC({
      payer: completePayer,
      recipient: completeRecipient,
      hasW9: false,
      nonemployeeCompensation: '5000',
    });
    expect(issues.map((i) => i.field)).toEqual(['recipient.w9']);
    expect(issues[0]!.fix).toBe('upload-w9');
  });

  it('flags below threshold (warning, not blocker)', () => {
    const issues = preflight1099NEC({
      payer: completePayer,
      recipient: completeRecipient,
      hasW9: true,
      nonemployeeCompensation: '450',
    });
    expect(issues.map((i) => i.field)).toEqual(['amount']);
  });

  it('flags missing payer EIN', () => {
    const issues = preflight1099NEC({
      payer: { ...completePayer, ein: null },
      recipient: completeRecipient,
      hasW9: true,
      nonemployeeCompensation: '5000',
    });
    expect(issues.some((i) => i.field === 'payer.ein')).toBe(true);
  });

  it('flags incomplete payer address', () => {
    const issues = preflight1099NEC({
      payer: { ...completePayer, address: { street1: '100 Main St' } },
      recipient: completeRecipient,
      hasW9: true,
      nonemployeeCompensation: '5000',
    });
    expect(issues.some((i) => i.field === 'payer.address')).toBe(true);
  });

  it('flags missing recipient TIN', () => {
    const issues = preflight1099NEC({
      payer: completePayer,
      recipient: { ...completeRecipient, taxId: null },
      hasW9: true,
      nonemployeeCompensation: '5000',
    });
    expect(issues.some((i) => i.field === 'recipient.taxId')).toBe(true);
  });

  it('flags incomplete recipient address', () => {
    const issues = preflight1099NEC({
      payer: completePayer,
      recipient: { ...completeRecipient, mailingAddress: { city: 'Austin' } },
      hasW9: true,
      nonemployeeCompensation: '5000',
    });
    expect(issues.some((i) => i.field === 'recipient.address')).toBe(true);
  });

  it('returns multiple issues at once', () => {
    const issues = preflight1099NEC({
      payer: { name: '' },
      recipient: { displayName: '' },
      hasW9: false,
      nonemployeeCompensation: '0',
    });
    const fields = issues.map((i) => i.field).sort();
    expect(fields).toContain('payer.name');
    expect(fields).toContain('payer.ein');
    expect(fields).toContain('payer.address');
    expect(fields).toContain('recipient.name');
    expect(fields).toContain('recipient.taxId');
    expect(fields).toContain('recipient.address');
    expect(fields).toContain('recipient.w9');
    expect(fields).toContain('amount');
  });
});

describe('render1099NEC', () => {
  const data = {
    payer: {
      name: 'KPBooks Test Co',
      ein: '12-3456789',
      address: completePayer.address,
      phone: '512-555-0100',
    },
    recipient: {
      name: 'Jane Contractor',
      taxId: '123-45-6789',
      address: completeRecipient.mailingAddress,
    },
    taxYear: 2025,
    nonemployeeCompensation: '12345.67',
  };

  it('produces a non-empty PDF buffer for Copy B', async () => {
    const buf = await render1099NEC(data, 'B');
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
    // PDF header magic
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('produces a non-empty PDF buffer for Copy C', async () => {
    const buf = await render1099NEC(data, 'C');
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('handles minimal address (street + city + state + ZIP only)', async () => {
    const minimal = {
      ...data,
      recipient: {
        ...data.recipient,
        address: { street1: '1 A St', city: 'X', state: 'TX', postalCode: '00000' },
      },
    };
    const buf = await render1099NEC(minimal, 'B');
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('handles zero nonemployee compensation gracefully', async () => {
    const buf = await render1099NEC({ ...data, nonemployeeCompensation: '0' }, 'B');
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('handles CORRECTED flag', async () => {
    const buf = await render1099NEC({ ...data, corrected: true }, 'B');
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });
});

describe('render1099NECCopies', () => {
  const data = {
    payer: {
      name: 'KPBooks Test Co',
      ein: '12-3456789',
      address: completePayer.address,
      phone: null,
    },
    recipient: {
      name: 'Jane Contractor',
      taxId: '123-45-6789',
      address: completeRecipient.mailingAddress,
    },
    taxYear: 2025,
    nonemployeeCompensation: '5000',
  };

  it('returns single PDF when one copy requested', async () => {
    const buf = await render1099NECCopies(data, ['B']);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('merges multiple copies into one document', async () => {
    const single = await render1099NECCopies(data, ['B']);
    const merged = await render1099NECCopies(data, ['B', 'C']);
    // Merged should be larger than a single (more pages -> more bytes).
    expect(merged.length).toBeGreaterThan(single.length);
  });

  it('throws on empty copy array', async () => {
    await expect(render1099NECCopies(data, [])).rejects.toThrow();
  });
});
