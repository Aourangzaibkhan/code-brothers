import PDFDocument from 'pdfkit';

/** Order shape accepted by {@link generateInvoicePdf}. */
export interface InvoiceOrder {
  id: string | number;
  customerName?: string;
  currency?: string;
  items: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
  }>;
  /** Tax rate as a fraction, e.g. `0.17` for 17%. Default 0. */
  taxRate?: number;
  notes?: string;
}

export interface InvoiceTotals {
  subtotal: number;
  tax: number;
  total: number;
}

export function computeInvoiceTotals(order: InvoiceOrder): InvoiceTotals {
  const subtotal = order.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0,
  );
  const taxRate = order.taxRate ?? 0;
  const tax = subtotal * taxRate;
  return { subtotal, tax, total: subtotal + tax };
}

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

/** Render a simple one-page invoice PDF for an order. */
export function generateInvoicePdf(order: InvoiceOrder): Promise<Buffer> {
  const currency = order.currency ?? 'USD';
  const taxRate = order.taxRate ?? 0;
  const totals = computeInvoiceTotals(order);

  return new Promise<Buffer>((resolve, reject) => {
    // compress: false keeps the text layer plainly extractable/searchable.
    // The order id also goes into the document metadata (literal strings in
    // the PDF info dict), since pdfkit hex-encodes page glyph runs.
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      compress: false,
      info: {
        Title: `Invoice ${order.id}`,
        Subject: `Invoice for order ${order.id}`,
        Keywords: `invoice, ${order.id}`,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(22).text('Invoice', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Invoice #: ${order.id}`);
    if (order.customerName) doc.text(`Customer: ${order.customerName}`);
    doc.text(`Date: ${new Date().toISOString().slice(0, 10)}`);
    doc.moveDown();

    doc.fontSize(14).text('Items');
    doc.fontSize(11);
    for (const item of order.items) {
      const lineTotal = item.quantity * item.unitPrice;
      doc.text(
        `${item.name} x${item.quantity} @ ${money(item.unitPrice, currency)} = ${money(lineTotal, currency)}`,
      );
    }
    doc.moveDown();

    doc.fontSize(12).text(`Subtotal: ${money(totals.subtotal, currency)}`);
    doc.text(
      `Tax (${(taxRate * 100).toFixed(2)}%): ${money(totals.tax, currency)}`,
    );
    doc.fontSize(14).text(`Total: ${money(totals.total, currency)}`);

    if (order.notes) {
      doc.moveDown();
      doc.fontSize(11).text(`Notes: ${order.notes}`);
    }
    doc.end();
  });
}
