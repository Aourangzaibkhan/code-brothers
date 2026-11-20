/**
 * Daily CEO Digest (spec §7 template 10: "Daily CEO WhatsApp Digest").
 *
 * Aggregates the merchant's orders / customers / verified payments for a
 * day (or the whole store when no date is given) into totals — orders,
 * revenue, returns, top SKUs — and renders them as a one-page PDF
 * through the same PDF code path as the ecommerce-local invoice
 * generator (`generateInvoicePdf`). `?format=json` (or body
 * `format: "json"`) returns the summary as JSON instead; delivery to
 * the owner's WhatsApp is a workflow built on top of this endpoint.
 */
import type { FastifyInstance } from 'fastify';
import { generateInvoicePdf } from '@code-brothers/connector-ecommerce-local';
import { str, userId, type OpsContext } from './context.js';

export interface DigestSummary {
  date: string;
  orders: number;
  revenue: number;
  returns: { count: number; total: number };
  cancelled: number;
  currency: string;
  topSkus: Array<{ sku: string; name: string; qty: number; revenue: number }>;
  customers: number;
  paymentsVerified: { count: number; total: number };
}

export function buildDigest(ctx: OpsContext, owner: string, date?: string): DigestSummary {
  const { ops } = ctx;
  const day = date ?? new Date(ctx.now()).toISOString().slice(0, 10);
  const orders = [...ops.orders.values()].filter(
    (o) => o.userId === owner && (!date || o.createdAt.slice(0, 10) === day),
  );
  const revenueOrders = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'returned');
  const returned = orders.filter((o) => o.status === 'returned');
  const revenue = revenueOrders.reduce((sum, o) => sum + o.total, 0);

  const bySku = new Map<string, { sku: string; name: string; qty: number; revenue: number }>();
  for (const order of revenueOrders) {
    for (const item of order.items) {
      const key = item.sku ?? item.name;
      const row = bySku.get(key) ?? { sku: key, name: item.name, qty: 0, revenue: 0 };
      row.qty += item.qty;
      row.revenue += item.qty * item.unitPrice;
      bySku.set(key, row);
    }
  }
  const topSkus = [...bySku.values()].sort((a, b) => b.qty - a.qty || b.revenue - a.revenue).slice(0, 5);

  const payments = [...ops.paymentTids.values()].filter(
    (t) => t.userId === owner && t.status === 'verified' && (!date || t.createdAt.slice(0, 10) === day),
  );
  const currency = revenueOrders[0]?.currency ?? orders[0]?.currency ?? 'PKR';

  return {
    date: day,
    orders: orders.length,
    revenue,
    returns: { count: returned.length, total: returned.reduce((sum, o) => sum + o.total, 0) },
    cancelled: orders.filter((o) => o.status === 'cancelled').length,
    currency,
    topSkus,
    customers: [...ops.customers.values()].filter((c) => c.userId === owner).length,
    paymentsVerified: {
      count: payments.length,
      total: payments.reduce((sum, t) => sum + t.amount, 0),
    },
  };
}

export function registerDigestRoutes(app: FastifyInstance, ctx: OpsContext): void {
  const { requireAuth } = ctx;

  app.post('/api/digest/generate', { preHandler: requireAuth }, async (req, reply) => {
    const owner = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const date = str(body.date);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.code(400).send({ error: 'validation_error', message: 'date must be YYYY-MM-DD' });
    }
    const summary = buildDigest(ctx, owner, date);
    const query = req.query as { format?: string };
    if (query.format === 'json' || body.format === 'json') {
      return { digest: summary };
    }

    const items =
      summary.topSkus.length > 0
        ? summary.topSkus.map((s) => ({
            name: `${s.name} (${s.sku})`,
            quantity: s.qty,
            unitPrice: s.qty > 0 ? s.revenue / s.qty : 0,
          }))
        : [{ name: 'No sales recorded', quantity: 1, unitPrice: 0 }];
    const pdf = await generateInvoicePdf({
      id: `CEO-DIGEST-${summary.date}`,
      customerName: 'Store Owner — Daily CEO Digest',
      currency: summary.currency,
      items,
      notes:
        `Orders: ${summary.orders} | Revenue: ${summary.currency} ${summary.revenue.toFixed(2)} | ` +
        `Returns: ${summary.returns.count} (${summary.currency} ${summary.returns.total.toFixed(2)}) | ` +
        `Cancelled: ${summary.cancelled} | Verified payments: ${summary.paymentsVerified.count} ` +
        `(${summary.currency} ${summary.paymentsVerified.total.toFixed(2)})`,
    });
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="ceo-digest-${summary.date}.pdf"`)
      .send(pdf);
  });
}
