/**
 * COD Fraud Shield (spec §7.3).
 *
 * Scores a prospective (usually cash-on-delivery) order 0–100 from the
 * buyer's cross-channel history in `customers_crm`, the orders store and
 * the `payment_tids` ledger. Thresholds (documented, tunable constants):
 *
 *   score < 30          -> "allow"            (ship it, COD is fine)
 *   30 <= score < 60    -> "require_advance"  (ask for a partial advance)
 *   score >= 60         -> "block"            (do not ship COD)
 *
 * Signals (points):
 *   each refused/returned COD parcel .... +15, capped at +60
 *   same phone re-ordering a near-identical total within 24h ... +25
 *   the order's TID was already verified once (reused screenshot) +40
 *   buyer linked to a TID with recorded duplicate attempts ...... +35
 *   phone number fails format validation ........................ +20
 *   order value > 3x the buyer's average order ................. +15
 *   order value >= 250,000 (extreme for COD) .................... +10
 *   buyer has no purchase history at all ........................ +10
 */
import type { FastifyInstance } from 'fastify';
import { nowIso, num, str, userId, type OpsContext } from './context.js';
import { findCustomerByPhone, isValidPhone, normalizePhone } from './customers.js';

export const FRAUD_ALLOW_BELOW = 30;
export const FRAUD_BLOCK_AT = 60;
export const FRAUD_POINTS = {
  codRefusalEach: 15,
  codRefusalCap: 60,
  duplicateRecentOrder: 25,
  tidReused: 40,
  tidDuplicateAttempts: 35,
  invalidPhone: 20,
  valueOutlier: 15,
  extremeValue: 10,
  noHistory: 10,
} as const;
export const EXTREME_ORDER_VALUE = 250_000;
export const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DUPLICATE_TOTAL_TOLERANCE = 0.05;

export type FraudDecision = 'allow' | 'require_advance' | 'block';

export interface FraudReason {
  signal: string;
  points: number;
  detail: string;
}

export function decisionForScore(score: number): FraudDecision {
  if (score >= FRAUD_BLOCK_AT) return 'block';
  if (score >= FRAUD_ALLOW_BELOW) return 'require_advance';
  return 'allow';
}

export function registerFraudRoutes(app: FastifyInstance, ctx: OpsContext): void {
  const { ops, requireAuth } = ctx;

  app.post('/api/fraud/assess', { preHandler: requireAuth }, async (req, reply) => {
    const owner = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const orderTotal = num(body.orderTotal) ?? num(body.total);
    if (orderTotal === undefined || orderTotal < 0) {
      return reply.code(400).send({ error: 'validation_error', message: 'orderTotal (number >= 0) is required' });
    }
    const rawPhone = str(body.phone);
    const phone = rawPhone ? normalizePhone(rawPhone) : undefined;

    let customer = str(body.customerId) ? ops.customers.get(str(body.customerId) as string) : undefined;
    if (customer && customer.userId !== owner) customer = undefined;
    if (!customer && phone) customer = findCustomerByPhone(ctx, owner, phone);

    const reasons: FraudReason[] = [];
    let score = 0;
    const add = (signal: string, points: number, detail: string): void => {
      score += points;
      reasons.push({ signal, points, detail });
    };

    // Phone format / country shape.
    if (!phone || !isValidPhone(phone)) {
      add('invalid_phone', FRAUD_POINTS.invalidPhone, 'Phone number is missing or fails format validation');
    }

    if (customer) {
      // Repeat COD canceller history (customers_crm.cod_refusals_count).
      if (customer.codRefusalsCount > 0) {
        const points = Math.min(
          FRAUD_POINTS.codRefusalCap,
          customer.codRefusalsCount * FRAUD_POINTS.codRefusalEach,
        );
        add(
          'cod_refusal_history',
          points,
          `Buyer refused/returned ${customer.codRefusalsCount} COD parcel(s) before`,
        );
      }
      // Order-value outlier vs the buyer's own average.
      if (customer.totalOrders > 0 && customer.totalSpent > 0) {
        const average = customer.totalSpent / customer.totalOrders;
        if (average > 0 && orderTotal > 3 * average) {
          add(
            'value_outlier',
            FRAUD_POINTS.valueOutlier,
            `Order value ${orderTotal} is over 3x the buyer's average order (${Math.round(average)})`,
          );
        }
      }
      // Buyer linked to a TID that someone already tried to reuse.
      const badTid = [...ops.paymentTids.values()].find(
        (t) => t.customerId === customer.id && t.duplicateAttempts > 0,
      );
      if (badTid) {
        add(
          'tid_duplicate_attempts',
          FRAUD_POINTS.tidDuplicateAttempts,
          `Buyer is linked to payment TID ${badTid.tid} with ${badTid.duplicateAttempts} duplicate attempt(s)`,
        );
      }
    } else {
      add('no_history', FRAUD_POINTS.noHistory, 'Buyer has no purchase history with this store');
    }

    // Duplicate recent order: same phone, near-identical total, < 24h.
    if (phone) {
      const nowMs = ctx.now();
      const duplicate = [...ops.orders.values()].find(
        (o) =>
          o.userId === owner &&
          o.phone === phone &&
          o.status !== 'cancelled' &&
          nowMs - Date.parse(o.createdAt) < DUPLICATE_WINDOW_MS &&
          Math.abs(o.total - orderTotal) <= Math.max(1, orderTotal * DUPLICATE_TOTAL_TOLERANCE),
      );
      if (duplicate) {
        add(
          'duplicate_recent_order',
          FRAUD_POINTS.duplicateRecentOrder,
          `Same phone placed a near-identical order (${duplicate.total}) within the last 24h`,
        );
      }
    }

    // The payment TID attached to this order was already verified once:
    // the classic reused-screenshot fraud (§7.3 duplicate TID ledger).
    const tid = str(body.tid);
    let duplicateTid = false;
    if (tid) {
      const existing = [...ops.paymentTids.values()].find((t) => t.tid === tid);
      if (existing) {
        duplicateTid = true;
        add('tid_reused', FRAUD_POINTS.tidReused, `Payment TID ${tid} was already verified for order ${existing.orderRef ?? existing.id}`);
      }
    }

    if (orderTotal >= EXTREME_ORDER_VALUE) {
      add('extreme_value', FRAUD_POINTS.extremeValue, `Order value ${orderTotal} is extreme for COD`);
    }

    score = Math.min(100, score);
    const decision = decisionForScore(score);

    if (customer) {
      ops.customers.set(customer.id, { ...customer, codRiskScore: score, updatedAt: nowIso(ctx) });
    }
    if (decision !== 'allow') {
      await ctx.audit(req, {
        userId: owner,
        eventType: 'cod_fraud_flagged',
        severity: decision === 'block' ? 'critical' : 'warning',
        details: { phone, orderTotal, score, decision },
      });
    }
    return {
      score,
      decision,
      reasons,
      flags: { duplicateTid },
      customerId: customer?.id,
      phone,
      thresholds: { allowBelow: FRAUD_ALLOW_BELOW, blockAtOrAbove: FRAUD_BLOCK_AT },
    };
  });
}
