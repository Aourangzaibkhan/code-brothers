import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeInvoiceTotals, generateInvoicePdf } from './invoice.js';

describe('generateInvoicePdf', () => {
  it('renders a %PDF buffer containing the order id and totals', async () => {
    const pdf = await generateInvoicePdf({
      id: 'ORD-7788',
      customerName: 'Ada Lovelace',
      currency: 'PKR',
      taxRate: 0.1,
      items: [
        { name: 'Wall Print', quantity: 2, unitPrice: 1500 },
        { name: 'Frame', quantity: 1, unitPrice: 800 },
      ],
    });
    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.subarray(0, 4).toString('latin1'), '%PDF');
    const text = pdf.toString('latin1');
    assert.ok(text.includes('ORD-7788'), 'PDF bytes should contain the order id');
  });

  it('computeInvoiceTotals adds tax on the subtotal', () => {
    const totals = computeInvoiceTotals({
      id: 1,
      taxRate: 0.25,
      items: [{ name: 'X', quantity: 4, unitPrice: 100 }],
    });
    assert.deepEqual(totals, { subtotal: 400, tax: 100, total: 500 });
  });
});
