/**
 * Customers CRM (spec §9 `customers_crm`) + the orders store that feeds
 * the COD Fraud Shield (§7.3) and the Daily CEO Digest (§7 / template 10).
 *
 * Buyers are tracked across channels by normalized phone number — the
 * same normalization the fraud shield uses — so a repeat COD canceller
 * on Daraz is recognized when he orders again on Shopify or WhatsApp.
 * Recording an order updates the customer's running stats, which is
 * what "per-customer order stats feeding the score" means in practice.
 */
import type { FastifyInstance } from 'fastify';
import { nowIso, num, str, userId, type OpsContext } from './context.js';
import type {
  CustomerRecord,
  OrderItemRecord,
  OrderRecord,
  OrderStatus,
} from './state.js';

/**
 * Normalize a buyer phone to `+<country><number>`: strips separators,
 * converts a leading `00` to `+`, and maps Pakistani local format
 * (03XX-XXXXXXX) to +92. Anything else numeric gets a `+` prefix.
 */
export function normalizePhone(raw: string): string {
  let phone = raw.replace(/[\s\-()]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+')) {
    if (/^0\d{10}$/.test(phone)) phone = `+92${phone.slice(1)}`;
    else if (/^\d{10,15}$/.test(phone)) phone = `+${phone}`;
  }
  return phone;
}

/** E.164-ish shape: `+`, non-zero first digit, 10–15 digits total. */
export function isValidPhone(phone: string): boolean {
  return /^\+[1-9]\d{9,14}$/.test(phone);
}

function customerView(c: CustomerRecord): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    preferredLanguage: c.preferredLanguage,
    codRiskScore: c.codRiskScore,
    totalOrders: c.totalOrders,
    codOrdersCount: c.codOrdersCount,
    codRefusalsCount: c.codRefusalsCount,
    totalSpent: c.totalSpent,
    channelRefs: c.channelRefs,
    notes: c.notes,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function findCustomerByPhone(
  ctx: OpsContext,
  owner: string,
  normalizedPhone: string,
): CustomerRecord | undefined {
  for (const c of ctx.ops.customers.values()) {
    if (c.userId === owner && c.phone === normalizedPhone) return c;
  }
  return undefined;
}

function readStats(body: Record<string, unknown>): {
  totalOrders: number;
  codOrdersCount: number;
  codRefusalsCount: number;
  totalSpent: number;
} {
  const stats = (body.stats ?? {}) as Record<string, unknown>;
  const pick = (flat: string, nested: string, fallback = 0): number =>
    num(body[flat]) ?? num(stats[nested]) ?? num(stats[flat]) ?? fallback;
  return {
    totalOrders: Math.max(0, Math.floor(pick('totalOrders', 'totalOrders'))),
    codOrdersCount: Math.max(0, Math.floor(pick('codOrdersCount', 'codOrders'))),
    codRefusalsCount: Math.max(
      0,
      Math.floor(pick('codRefusalsCount', 'codRefusals') ?? pick('codCancelledCount', 'codCancelled')),
    ),
    totalSpent: pick('totalSpent', 'totalSpent'),
  };
}

export function registerCustomerRoutes(app: FastifyInstance, ctx: OpsContext): void {
  const { ops, requireAuth } = ctx;

  app.post('/api/customers', { preHandler: requireAuth }, async (req, reply) => {
    const owner = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawPhone = str(body.phone);
    const email = str(body.email)?.toLowerCase();
    if (!rawPhone && !email) {
      return reply.code(400).send({ error: 'validation_error', message: 'phone or email is required' });
    }
    const phone = rawPhone ? normalizePhone(rawPhone) : undefined;
    // §9: unique (user_id, phone) and (user_id, email) when present.
    for (const c of ops.customers.values()) {
      if (c.userId !== owner) continue;
      if (phone && c.phone === phone) {
        return reply.code(409).send({ error: 'customer_exists', message: `A customer with phone ${phone} already exists` });
      }
      if (email && c.email === email) {
        return reply.code(409).send({ error: 'customer_exists', message: `A customer with email ${email} already exists` });
      }
    }
    const ts = nowIso(ctx);
    const record: CustomerRecord = {
      id: ops.newId(),
      userId: owner,
      name: str(body.name),
      phone,
      email,
      preferredLanguage: str(body.preferredLanguage) ?? 'en',
      codRiskScore: num(body.codRiskScore) ?? 0,
      ...readStats(body),
      channelRefs:
        body.channelRefs && typeof body.channelRefs === 'object'
          ? (body.channelRefs as Record<string, string>)
          : {},
      notes: str(body.notes),
      createdAt: ts,
      updatedAt: ts,
    };
    ops.customers.set(record.id, record);
    return reply.code(201).send(customerView(record));
  });

  app.get('/api/customers', { preHandler: requireAuth }, async (req) => {
    const owner = userId(req);
    const query = req.query as { phone?: string };
    let rows = [...ops.customers.values()].filter((c) => c.userId === owner);
    if (query.phone) {
      const needle = normalizePhone(query.phone);
      rows = rows.filter((c) => c.phone === needle);
    }
    return { customers: rows.map(customerView) };
  });

  app.get<{ Params: { id: string } }>(
    '/api/customers/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = ops.customers.get(req.params.id);
      if (!record || record.userId !== userId(req)) {
        return reply.code(404).send({ error: 'customer_not_found' });
      }
      return customerView(record);
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/customers/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const owner = userId(req);
      const record = ops.customers.get(req.params.id);
      if (!record || record.userId !== owner) {
        return reply.code(404).send({ error: 'customer_not_found' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawPhone = str(body.phone);
      const phone = rawPhone ? normalizePhone(rawPhone) : record.phone;
      const email = body.email === null ? undefined : (str(body.email)?.toLowerCase() ?? record.email);
      for (const c of ops.customers.values()) {
        if (c.userId !== owner || c.id === record.id) continue;
        if (phone && c.phone === phone) {
          return reply.code(409).send({ error: 'customer_exists', message: `A customer with phone ${phone} already exists` });
        }
        if (email && c.email === email) {
          return reply.code(409).send({ error: 'customer_exists', message: `A customer with email ${email} already exists` });
        }
      }
      const hasStats =
        body.stats !== undefined ||
        ['totalOrders', 'codOrdersCount', 'codRefusalsCount', 'codCancelledCount', 'totalSpent'].some(
          (k) => body[k] !== undefined,
        );
      const next: CustomerRecord = {
        ...record,
        name: str(body.name) ?? record.name,
        phone,
        email,
        preferredLanguage: str(body.preferredLanguage) ?? record.preferredLanguage,
        codRiskScore: num(body.codRiskScore) ?? record.codRiskScore,
        ...(hasStats ? readStats(body) : {}),
        notes: body.notes === null ? undefined : (str(body.notes) ?? record.notes),
        updatedAt: nowIso(ctx),
      };
      ops.customers.set(next.id, next);
      return customerView(next);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/customers/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = ops.customers.get(req.params.id);
      if (!record || record.userId !== userId(req)) {
        return reply.code(404).send({ error: 'customer_not_found' });
      }
      ops.customers.delete(record.id);
      return reply.code(204).send();
    },
  );

  // -- orders (fraud + digest source data) ----------------------------------

  function orderView(o: OrderRecord): Record<string, unknown> {
    return {
      id: o.id,
      customerId: o.customerId,
      phone: o.phone,
      channel: o.channel,
      items: o.items,
      total: o.total,
      currency: o.currency,
      status: o.status,
      paymentMethod: o.paymentMethod,
      createdAt: o.createdAt,
    };
  }

  app.post('/api/orders', { preHandler: requireAuth }, async (req, reply) => {
    const owner = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const items: OrderItemRecord[] = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const name = str(item.name);
      if (!name) continue;
      items.push({
        sku: str(item.sku) ?? str(item.masterSku),
        name,
        qty: Math.max(1, Math.floor(num(item.qty) ?? 1)),
        unitPrice: num(item.unitPrice) ?? num(item.price) ?? 0,
      });
    }
    const computed = items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
    const total = num(body.total) ?? computed;
    const status = (['completed', 'delivered', 'cancelled', 'returned', 'pending'].includes(
      String(body.status),
    )
      ? body.status
      : 'completed') as OrderStatus;
    const paymentMethod = body.paymentMethod === 'cod' ? 'cod' : 'prepaid';
    const rawPhone = str(body.phone);
    const phone = rawPhone ? normalizePhone(rawPhone) : undefined;

    // Resolve the customer (explicit id wins, else by phone) and feed stats.
    let customer: CustomerRecord | undefined;
    const customerId = str(body.customerId);
    if (customerId) customer = ops.customers.get(customerId);
    if (!customer && phone) customer = findCustomerByPhone(ctx, owner, phone);
    if (customer && customer.userId !== owner) customer = undefined;

    const createdAt =
      typeof body.createdAt === 'string' && !Number.isNaN(Date.parse(body.createdAt))
        ? new Date(body.createdAt).toISOString()
        : nowIso(ctx);
    const order: OrderRecord = {
      id: ops.newId(),
      userId: owner,
      customerId: customer?.id,
      phone,
      channel: str(body.channel) ?? 'local',
      items,
      total,
      currency: str(body.currency) ?? 'PKR',
      status,
      paymentMethod,
      createdAt,
    };
    ops.orders.set(order.id, order);

    if (customer) {
      const next: CustomerRecord = { ...customer, updatedAt: nowIso(ctx) };
      next.totalOrders += 1;
      if (paymentMethod === 'cod') {
        next.codOrdersCount += 1;
        if (status === 'cancelled' || status === 'returned') next.codRefusalsCount += 1;
      }
      if (status !== 'cancelled') next.totalSpent += total;
      ops.customers.set(next.id, next);
    }
    return reply.code(201).send(orderView(order));
  });

  app.get('/api/orders', { preHandler: requireAuth }, async (req) => {
    const owner = userId(req);
    const query = req.query as { channel?: string; customerId?: string };
    let rows = [...ops.orders.values()].filter((o) => o.userId === owner);
    if (query.channel) rows = rows.filter((o) => o.channel === query.channel);
    if (query.customerId) rows = rows.filter((o) => o.customerId === query.customerId);
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { orders: rows.map(orderView) };
  });
}
