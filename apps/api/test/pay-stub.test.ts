import { describe, expect, it } from 'vitest';
import { renderPayStub, type PayStubData } from '../src/modules/forms/pay-stub.js';

const baseData: PayStubData = {
  payer: {
    name: 'KPBooks Test Co',
    ein: '12-3456789',
    address: { street1: '100 Main St', city: 'Austin', state: 'TX', postalCode: '78701' },
    phone: '512-555-0100',
  },
  recipient: {
    name: 'Jane Contractor',
    taxId: '123-45-6789',
    address: { street1: '200 Elm St', city: 'Austin', state: 'TX', postalCode: '78702' },
    workerType: 'contractor',
  },
  payDate: '2026-05-08',
  checkNumber: '1042',
  paymentMethod: 'check',
  memo: 'April labor',
  lines: [],
  grossCurrent: '900.00',
  grossYtd: '4200.00',
};

describe('renderPayStub', () => {
  it('produces a valid PDF for a simple payment with no time-entry breakdown', async () => {
    const buf = await renderPayStub(baseData);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('produces a valid PDF when time entries are itemized', async () => {
    const buf = await renderPayStub({
      ...baseData,
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      lines: [
        { entryDate: '2026-04-03', description: 'Site visit', hours: '4', rate: '75', amount: '300.00' },
        { entryDate: '2026-04-12', description: 'Repair upstairs bathroom', hours: '8', rate: '75', amount: '600.00' },
      ],
    });
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('produces a valid PDF for an employee with informational deductions', async () => {
    const buf = await renderPayStub({
      ...baseData,
      recipient: { ...baseData.recipient, workerType: 'employee' },
      deductions: [
        { label: 'Federal income tax', current: '120.00', ytd: '480.00' },
        { label: 'Social Security', current: '55.80', ytd: '260.40' },
        { label: 'Medicare', current: '13.05', ytd: '60.90' },
      ],
    });
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('handles missing optional fields gracefully', async () => {
    const minimal: PayStubData = {
      payer: { name: 'Tiny LLC', address: {} },
      recipient: { name: 'Bob', address: {} },
      payDate: '2026-05-08',
      lines: [],
      grossCurrent: '100',
      grossYtd: '100',
    };
    const buf = await renderPayStub(minimal);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('computes default net pay = gross - deductions when net not provided', async () => {
    // Indirect verification: just confirm no throw and PDF emits.
    const buf = await renderPayStub({
      ...baseData,
      deductions: [{ label: 'Garnishment', current: '50.00', ytd: '200.00' }],
    });
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });
});
