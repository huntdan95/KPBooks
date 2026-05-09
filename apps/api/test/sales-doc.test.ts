import { describe, expect, it } from 'vitest';
import {
  renderSalesDoc,
  type EstimateData,
  type InvoiceData,
} from '../src/modules/forms/sales-doc.js';

const baseInvoice: InvoiceData = {
  kind: 'invoice',
  payer: {
    name: 'KPBooks Test Co',
    address: { street1: '100 Main St', city: 'Austin', state: 'TX', postalCode: '78701' },
    phone: '512-555-0100',
    email: 'billing@example.com',
  },
  customer: {
    name: 'Acme LLC',
    accountNumber: 'C-1042',
    email: 'ap@acme.com',
    address: { street1: '200 Customer Ave', city: 'Austin', state: 'TX', postalCode: '78702' },
  },
  documentNumber: 'INV-1042',
  invoiceDate: '2026-04-01',
  dueDate: '2026-04-30',
  termsDays: 30,
  status: 'open',
  memo: 'Thanks for the business!',
  lines: [
    {
      lineNumber: 1,
      description: 'Site visit',
      quantity: '4',
      unitPrice: '75',
      amount: '300.00',
      taxable: false,
    },
    {
      lineNumber: 2,
      description: 'Repair',
      quantity: '8',
      unitPrice: '75',
      amount: '600.00',
      taxable: true,
    },
  ],
  subtotal: '900.00',
  taxRateLabel: 'TX 8.25%',
  taxAmount: '49.50',
  total: '949.50',
  balanceDue: '949.50',
};

const baseEstimate: EstimateData = {
  kind: 'estimate',
  payer: baseInvoice.payer,
  customer: baseInvoice.customer,
  documentNumber: 'EST-1001',
  estimateDate: '2026-03-15',
  expirationDate: '2026-04-15',
  termsDays: 30,
  status: 'sent',
  memo: 'Quote good for 30 days.',
  lines: baseInvoice.lines,
  subtotal: '900.00',
  taxRateLabel: 'TX 8.25%',
  taxAmount: '49.50',
  total: '949.50',
};

describe('renderSalesDoc -- invoice', () => {
  it('produces a valid PDF for an open invoice', async () => {
    const buf = await renderSalesDoc(baseInvoice);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('produces a valid PDF for a paid invoice', async () => {
    const buf = await renderSalesDoc({ ...baseInvoice, status: 'paid', balanceDue: '0' });
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('produces a valid PDF for a void invoice', async () => {
    const buf = await renderSalesDoc({ ...baseInvoice, status: 'void' });
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('paginates when there are many lines', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({
      lineNumber: i + 1,
      description: `Line item ${i + 1}`,
      quantity: '1',
      unitPrice: '100',
      amount: '100.00',
      taxable: false,
    }));
    const buf = await renderSalesDoc({ ...baseInvoice, lines });
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(2500);
  });
});

describe('renderSalesDoc -- estimate', () => {
  it('produces a valid PDF for a sent estimate', async () => {
    const buf = await renderSalesDoc(baseEstimate);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('shows converted-invoice link when status is converted', async () => {
    const buf = await renderSalesDoc({
      ...baseEstimate,
      status: 'converted',
      convertedInvoiceNumber: 'INV-1100',
    });
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('handles minimal data without throwing', async () => {
    const buf = await renderSalesDoc({
      ...baseEstimate,
      memo: null,
      taxAmount: '0',
      taxRateLabel: null,
      expirationDate: null,
    });
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });
});
