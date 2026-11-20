/**
 * Duplicate Payment TID Ledger (spec §7.3, §9 `payment_tids`).
 *
 * Buyers pay by JazzCash / EasyPaisa / UPI / PIX / bank transfer and send
 * a screenshot; the transaction id (TID) on it is verified here exactly
 * once. `payment_tids.tid` is globally UNIQUE in the schema — a second
 * verification of the same TID is rejected with 409 and counted as a
 * duplicate attempt on the original record (which the COD Fraud Shield
 * reads as a risk signal). Listings expose amounts and metadata only —
 * no secrets exist in this ledger.
 */
import type { FastifyInstance } from 'fastify';
import { nowIso, num, str, userId, type OpsContext } from './context.js';
import type { PaymentTidRecord, TidProvider } from './state.js';

const PROVIDERS: TidProvider[] = ['jazzcash', 'easypaisa', 'bank', 'upi', 'pix', 'other'];
/** JazzCash/EasyPaisa/bank/UPI/PIX references: 6–64 alphanumerics/dashes. */
const TID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{5,63}$/;

function view(t: PaymentTidRecord): Record<string, unknown> {
  return {
    id: t.id,
    tid: t.tid,
    provider: t.provider,
    amount: t.amount,
    currency: t.currency,
    orderRef: t.orderRef,
    customerId: t.customerId,
    status: t.status,
    duplicateAttempts: t.duplicateAttempts,
    verifiedAt: t.verifiedAt,
    createdAt: t.createdAt,
  };
}

export function registerPaymentRoutes(app: FastifyInstance, ctx: OpsContext): void {
  const { ops, requireAuth } = ctx;

  app.post('/api/payments/verify-tid', { preHandler: requireAuth }, async (req, reply) => {
    const owner = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tid = str(body.tid);
    const amount = num(body.amount);
    if (!tid || !TID_RE.test(tid)) {
      return reply.code(400).send({
        error: 'invalid_tid_format',
        message: 'tid must be 6-64 alphanumeric characters (dashes allowed)',
      });
    }
    if (amount === undefined || amount <= 0) {
      return reply.code(400).send({ error: 'validation_error', message: 'amount (number > 0) is required' });
    }
    const rawProvider = (str(body.provider) ?? str(body.channel) ?? 'bank').toLowerCase();
    const provider = (PROVIDERS.includes(rawProvider as TidProvider) ? rawProvider : 'other') as TidProvider;

    // Global uniqueness (§9): the same TID can never be verified twice,
    // even across merchants — that is the reused-screenshot shield.
    const existing = [...ops.paymentTids.values()].find((t) => t.tid === tid);
    if (existing) {
      existing.duplicateAttempts += 1;
      existing.updatedAt = nowIso(ctx);
      ops.paymentTids.set(existing.id, existing);
      await ctx.audit(req, {
        userId: owner,
        eventType: 'payment_tid_duplicate',
        severity: 'critical',
        details: { tid, orderRef: str(body.orderId), originalOrderRef: existing.orderRef },
      });
      return reply.code(409).send({
        error: 'duplicate_tid',
        message: `TID ${tid} was already verified for order ${existing.orderRef ?? existing.id}`,
        tid: existing.tid,
        orderRef: existing.orderRef,
        verifiedAt: existing.verifiedAt,
      });
    }

    const ts = nowIso(ctx);
    const record: PaymentTidRecord = {
      id: ops.newId(),
      userId: owner,
      tid,
      provider,
      amount,
      currency: str(body.currency) ?? 'PKR',
      orderRef: str(body.orderId) ?? str(body.orderRef),
      customerId: str(body.customerId),
      status: 'verified',
      duplicateAttempts: 0,
      verifiedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };
    ops.paymentTids.set(record.id, record);
    return reply.code(201).send(view(record));
  });

  app.get('/api/payments/tids', { preHandler: requireAuth }, async (req) => {
    const owner = userId(req);
    const rows = [...ops.paymentTids.values()]
      .filter((t) => t.userId === owner)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { tids: rows.map(view) };
  });

  app.get<{ Params: { id: string } }>(
    '/api/payments/tids/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = ops.paymentTids.get(req.params.id);
      if (!record || record.userId !== userId(req)) {
        return reply.code(404).send({ error: 'payment_tid_not_found' });
      }
      return view(record);
    },
  );
}
