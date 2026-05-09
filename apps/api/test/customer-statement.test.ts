import { describe, expect, it } from 'vitest';
import {
  renderCustomerStatement,
  type CustomerStatementData,
} from '../src/modules/forms/customer-statement.js';

const baseData: CustomerStatementData = {
  payer: {
    name: 'KPBooks Test Co',
    address: { street1: '100 Main St', city: 'Austin', state: 'TX', postalCode: '78701' },
    phone: '512-555-0100',
    email: 'billing@kpbooks-test.com',
  },
  customer: {
    name: 'Acme LLC',
    accountNumber: 'C-1042',
    address: { street1: '200 Customer Ave', city: 'Austin', state: 'TX', postalCode: '78702' },
  },
  periodStart: '2026-04-01',
  periodEnd: '2026-04-30',
  asOf: '2026-04-30',
  openingBalance: '0',
  closingBalance: '0',
  rows: [
    {
      date: '2026-04-01',
      type: 'opening',
      reference: '',
      description: 'Balance forward',
      charge: '0',
      paymentAmount: '0',
      runningBalance: '0',
    },
  ],
  aging: {
    current: '0',
    days1to30: '0',
    days31to60: '0',
    days61to90: '0',
    days91plus: '0',
    total: '0',
  },
};

describe('renderCustomerStatement', () => {
  it('produces a valid PDF for an empty period', async () => {
    const buf = await renderCustomerStatement(baseData);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('produces a valid PDF with several activity rows', async () => {
    const buf = await renderCustomerStatement({
      ...baseData,
      openingBalance: '500.00',
      closingBalance: '350.00',
      rows: [
        {
          date: '2026-04-01',
          type: 'opening',
          reference: '',
          description: 'Balance forward',
          charge: '0',
          paymentAmount: '0',
          runningBalance: '500.00',
        },
        {
          date: '2026-04-05',
          type: 'invoice',
          reference: 'INV-1042',
          description: 'April retainer',
          charge: '750.00',
          paymentAmount: '0',
          runningBalance: '1250.00',
        },
        {
          date: '2026-04-15',
          type: 'payment',
          reference: 'check #2031',
          description: 'Payment received',
          charge: '0',
          paymentAmount: '900.00',
          runningBalance: '350.00',
        },
      ],
      aging: {
        current: '350.00',
        days1to30: '0',
        days31to60: '0',
        days61to90: '0',
        days91plus: '0',
        total: '350.00',
      },
    });
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(1500);
  });

  it('paginates when there are many activity rows', async () => {
    const rows: CustomerStatementData['rows'] = [
      {
        date: '2026-04-01',
        type: 'opening',
        reference: '',
        description: 'Balance forward',
        charge: '0',
        paymentAmount: '0',
        runningBalance: '0',
      },
    ];
    let bal = 0;
    for (let i = 0; i < 60; i++) {
      bal += 100;
      rows.push({
        date: '2026-04-' + String((i % 28) + 1).padStart(2, '0'),
        type: 'invoice',
        reference: `INV-${1000 + i}`,
        description: `Service ${i}`,
        charge: '100.00',
        paymentAmount: '0',
        runningBalance: bal.toFixed(2),
      });
    }
    const buf = await renderCustomerStatement({
      ...baseData,
      openingBalance: '0',
      closingBalance: bal.toFixed(2),
      rows,
      aging: {
        current: bal.toFixed(2),
        days1to30: '0',
        days31to60: '0',
        days61to90: '0',
        days91plus: '0',
        total: bal.toFixed(2),
      },
    });
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(2500);
  });

  it('handles missing optional fields without throwing', async () => {
    const buf = await renderCustomerStatement({
      ...baseData,
      payer: { name: 'Tiny Co', address: {} },
      customer: { name: 'Bob', address: {} },
    });
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });
});
