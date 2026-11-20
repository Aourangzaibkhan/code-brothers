/**
 * Business/operations module tests (spec §7): SKU sync, COD fraud shield,
 * TID ledger, unified inbox + approval queue, courier hub, CEO digest,
 * encrypted backups. Same conventions as ../app.test.ts (fastify inject,
 * in-memory stores).
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { generateMasterKey, parseMasterKey } from '@code-brothers/security';
import { buildApp, type BuiltApi } from '../app.js';

const MASTER_KEY = parseMasterKey(generateMasterKey());
const OWNER_EMAIL = 'owner@example.com';
const OWNER_PASSWORD = 'correct horse battery';

async function makeApi(t: TestContext, extra: Parameters<typeof buildApp>[0] = {}): Promise<BuiltApi> {
  const built = await buildApp({ masterKey: MASTER_KEY, ...extra });
  t.after(async () => {
    await built.app.close();
  });
  return built;
}

async function claimOwner(built: BuiltApi): Promise<string> {
  const res = await built.app.inject({
    method: 'POST',
    url: '/api/setup/claim',
    payload: { setupToken: built.setupToken, email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { token: string }).token;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function inject(
  built: BuiltApi,
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, any>; raw: any }> {
  const res = await built.app.inject({ method, url, headers: auth(token), payload });
  let body: Record<string, any> = {};
  try {
    body = res.json() as Record<string, any>;
  } catch {
    body = {};
  }
  return { statusCode: res.statusCode, body, raw: res };
}

describe('SKU mapper + cross-channel stock sync (§7.2)', () => {
  it('enforces §9 uniqueness and deducts a sale from every channel', async (t) => {
    const built = await makeApi(t);
    const token = await claimOwner(built);

    const created = await inject(built, token, 'POST', '/api/catalog/sku-mappings', {
      masterSku: 'TSHIRT-RED-M',
      shopifySku: 'SHOP-100',
      darazSku: 'DRZ-200',
      localSku: 'LOC-300',
      stock: { shopify: 10, daraz: 8, local: 5 },
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    assert.equal(created.body.masterSku, 'TSHIRT-RED-M');

    const dupMaster = await inject(built, token, 'POST', '/api/catalog/sku-mappings', {
      masterSku: 'TSHIRT-RED-M',
      shopifySku: 'SHOP-999',
    });
    assert.equal(dupMaster.statusCode, 409);

    const dupChannel = await inject(built, token, 'POST', '/api/catalog/sku-mappings', {
      masterSku: 'TSHIRT-BLUE-M',
      darazSku: 'DRZ-200',
    });
    assert.equal(dupChannel.statusCode, 409);

    const sale = await inject(built, token, 'POST', '/api/catalog/sync-sale', {
      channel: 'shopify',
      channelSku: 'SHOP-100',
      qty: 3,
    });
    assert.equal(sale.statusCode, 200, JSON.stringify(sale.body));
    assert.equal(sale.body.masterSku, 'TSHIRT-RED-M');
    assert.equal(sale.body.source.stockAfter, 7);
    const plan = sale.body.plan as Array<{ channel: string; deductQty: number; stockAfter: number }>;
    assert.equal(plan.length, 2);
    const daraz = plan.find((p) => p.channel === 'daraz') as { deductQty: number; stockAfter: number };
    const local = plan.find((p) => p.channel === 'local') as { deductQty: number; stockAfter: number };
    assert.deepEqual([daraz.deductQty, daraz.stockAfter], [3, 5]);
    assert.deepEqual([local.deductQty, local.stockAfter], [3, 2]);

    const list = await inject(built, token, 'GET', '/api/catalog/sku-mappings');
    const mapping = (list.body.mappings as Array<{ stock: Record<string, number> }>)[0];
    assert.deepEqual(mapping.stock, { shopify: 7, daraz: 5, local: 2 });

    const unknown = await inject(built, token, 'POST', '/api/catalog/sync-sale', {
      channel: 'daraz',
      channelSku: 'NOPE-1',
      qty: 1,
    });
    assert.equal(unknown.statusCode, 404);
  });
});

describe('customers CRM + COD fraud shield (§7.3)', () => {
  it('allows a clean customer, escalates a repeat canceller, blocks the worst', async (t) => {
    const built = await makeApi(t);
    const token = await claimOwner(built);

    const clean = await inject(built, token, 'POST', '/api/customers', {
      name: 'Clean Buyer',
      phone: '+92 300 1234567',
      totalOrders: 5,
      codOrdersCount: 5,
      codRefusalsCount: 0,
      totalSpent: 5000,
    });
    assert.equal(clean.statusCode, 201, JSON.stringify(clean.body));
    assert.equal(clean.body.phone, '+923001234567', 'phone is stored normalized');

    const dupPhone = await inject(built, token, 'POST', '/api/customers', { phone: '03001234567' });
    assert.equal(dupPhone.statusCode, 409, 'same normalized phone is a conflict');

    const cleanAssess = await inject(built, token, 'POST', '/api/fraud/assess', {
      phone: '0300-1234567',
      orderTotal: 1200,
    });
    assert.equal(cleanAssess.statusCode, 200);
    assert.equal(cleanAssess.body.score, 0);
    assert.equal(cleanAssess.body.decision, 'allow');

    await inject(built, token, 'POST', '/api/customers', {
      name: 'Repeat Canceller',
      phone: '+923217654321',
      totalOrders: 6,
      codOrdersCount: 6,
      codRefusalsCount: 3,
      totalSpent: 6000,
    });
    const riskyAssess = await inject(built, token, 'POST', '/api/fraud/assess', {
      phone: '+923217654321',
      orderTotal: 1000,
    });
    assert.equal(riskyAssess.body.score, 45);
    assert.equal(riskyAssess.body.decision, 'require_advance');
    assert.ok(
      (riskyAssess.body.reasons as Array<{ signal: string }>).some((r) => r.signal === 'cod_refusal_history'),
    );

    await inject(built, token, 'POST', '/api/customers', {
      name: 'Serial Refuser',
      phone: '+923335556666',
      totalOrders: 10,
      codOrdersCount: 10,
      codRefusalsCount: 5,
      totalSpent: 10000,
    });
    const blockedAssess = await inject(built, token, 'POST', '/api/fraud/assess', {
      phone: '+923335556666',
      orderTotal: 1000,
    });
    assert.equal(blockedAssess.body.score, 60);
    assert.equal(blockedAssess.body.decision, 'block');
  });

  it('flags an order whose TID was already verified (reused screenshot)', async (t) => {
    const built = await makeApi(t);
    const token = await claimOwner(built);

    const verified = await inject(built, token, 'POST', '/api/payments/verify-tid', {
      tid: 'JC-998877',
      amount: 1500,
      orderId: 'ORD-100',
      channel: 'jazzcash',
    });
    assert.equal(verified.statusCode, 201);

    const assess = await inject(built, token, 'POST', '/api/fraud/assess', {
      phone: '+923334445555',
      orderTotal: 1500,
      tid: 'JC-998877',
    });
    assert.equal(assess.body.flags.duplicateTid, true);
    assert.ok(
      (assess.body.reasons as Array<{ signal: string }>).some((r) => r.signal === 'tid_reused'),
    );
    assert.equal(assess.body.decision, 'require_advance');
  });
});

describe('payment TID ledger (§7.3)', () => {
  it('verifies once, rejects duplicates with 409, validates format', async (t) => {
    const built = await makeApi(t);
    const token = await claimOwner(built);

    const bad = await inject(built, token, 'POST', '/api/payments/verify-tid', {
      tid: 'x!',
      amount: 100,
      orderId: 'ORD-1',
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.error, 'invalid_tid_format');

    const first = await inject(built, token, 'POST', '/api/payments/verify-tid', {
      tid: 'EP-555444',
      amount: 2500,
      orderId: 'ORD-200',
      channel: 'easypaisa',
    });
    assert.equal(first.statusCode, 201, JSON.stringify(first.body));
    assert.equal(first.body.status, 'verified');
    assert.equal(first.body.provider, 'easypaisa');
    assert.equal(first.body.amount, 2500);

    const duplicate = await inject(built, token, 'POST', '/api/payments/verify-tid', {
      tid: 'EP-555444',
      amount: 2500,
      orderId: 'ORD-201',
      channel: 'easypaisa',
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.body.error, 'duplicate_tid');

    const list = await inject(built, token, 'GET', '/api/payments/tids');
    const tids = list.body.tids as Array<{ tid: string; duplicateAttempts: number }>;
    assert.equal(tids.length, 1);
    assert.equal(tids[0].duplicateAttempts, 1, 'the duplicate attempt is counted on the original record');
  });
});

describe('unified inbox, takeover + approval queue (§7.1)', () => {
  it('auto-replies until takeover, human reply pauses the AI', async (t) => {
    const built = await makeApi(t);
    const token = await claimOwner(built);

    const first = await inject(built, token, 'POST', '/api/inbox/messages', {
      channel: 'whatsapp',
      externalId: '+923001112222',
      displayName: 'Buyer One',
      body: 'Hello, what is the price of this?',
    });
    assert.equal(first.statusCode, 201, JSON.stringify(first.body));
    assert.ok(first.body.autoReply, 'AI replies while not paused');
    assert.equal(first.body.autoReply.sender, 'ai');
    const conversationId = first.body.conversation.id as string;

    const takeover = await inject(built, token, 'POST', `/api/inbox/conversations/${conversationId}/takeover`, {
      paused: true,
    });
    assert.equal(takeover.body.conversation.aiPaused, true);

    const whilePaused = await inject(built, token, 'POST', '/api/inbox/messages', {
      channel: 'whatsapp',
      externalId: '+923001112222',
      body: 'And the delivery charges?',
    });
    assert.equal(whilePaused.body.autoReply, undefined, 'no auto-reply during human takeover');
    assert.equal(whilePaused.body.aiPaused, true);

    const humanReply = await inject(built, token, 'POST', `/api/inbox/conversations/${conversationId}/reply`, {
      body: 'I will check and confirm both for you.',
    });
    assert.equal(humanReply.statusCode, 201);
    assert.equal(humanReply.body.message.sender, 'human');

    const thread = await inject(built, token, 'GET', `/api/inbox/conversations/${conversationId}/messages`);
    const senders = (thread.body.messages as Array<{ sender: string }>).map((m) => m.sender);
    assert.deepEqual(senders, ['customer', 'ai', 'customer', 'human']);

    const resume = await inject(built, token, 'POST', `/api/inbox/conversations/${conversationId}/takeover`, {
      paused: false,
    });
    assert.equal(resume.body.conversation.aiPaused, false);
    const afterResume = await inject(built, token, 'POST', '/api/inbox/messages', {
      channel: 'whatsapp',
      externalId: '+923001112222',
      body: 'Thanks!',
    });
    assert.ok(afterResume.body.autoReply, 'AI replies again after takeover ends');
  });

  it('runs the executor on approve and never on reject', async (t) => {
    const built = await makeApi(t);
    const token = await claimOwner(built);

    const created = await inject(built, token, 'POST', '/api/approvals', {
      type: 'send_message',
      payload: { channel: 'whatsapp', to: '+923001112222', body: 'Your order has shipped!' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.status, 'pending');
    const approvalId = created.body.id as string;

    const approved = await inject(built, token, 'POST', `/api/approvals/${approvalId}/approve`, {});
    assert.equal(approved.statusCode, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'executed');
    assert.ok(approved.body.executionResult.sentMessageId);

    const sent = await inject(built, token, 'GET', '/api/inbox/sent');
    assert.equal((sent.body.sent as unknown[]).length, 1);
    assert.equal((sent.body.sent as Array<{ body: string }>)[0].body, 'Your order has shipped!');

    const second = await inject(built, token, 'POST', '/api/approvals', {
      type: 'send_message',
      payload: { channel: 'whatsapp', to: '+923001112222', body: 'This must never be sent' },
    });
    const rejected = await inject(built, token, 'POST', `/api/approvals/${second.body.id}/reject`, {});
    assert.equal(rejected.body.status, 'rejected');
    const sentAfter = await inject(built, token, 'GET', '/api/inbox/sent');
    assert.equal((sentAfter.body.sent as unknown[]).length, 1, 'rejected actions never execute');

    const again = await inject(built, token, 'POST', `/api/approvals/${approvalId}/approve`, {});
    assert.equal(again.statusCode, 409, 'an approval can only be decided once');
  });
});

describe('courier hub (§7.4)', () => {
  const mockFetch = async (input: unknown): Promise<Response> => {
    const url = String(input);
    const json = (status: number, data: unknown): Response =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/v1/bookings')) {
      return json(201, { data: { awb_no: 'EXP-9001', label_url: 'https://labels.example/EXP-9001.pdf' } });
    }
    if (url.includes('/v1/track/')) {
      return json(200, {
        data: {
          awb_no: 'EXP-9001',
          status: 'Out for delivery',
          history: [{ timestamp: '2026-11-20T07:30:00Z', description: 'Picked up', location: 'Dubai' }],
        },
      });
    }
    return json(404, { error: 'not found' });
  };

  it('books and tracks through the connector preset against a mock fetch', async (t) => {
    const built = await makeApi(t, { courierFetch: mockFetch as typeof fetch });
    const token = await claimOwner(built);

    const presets = await inject(built, token, 'GET', '/api/couriers/presets');
    const ids = (presets.body.presets as Array<{ id: string }>).map((p) => p.id);
    assert.deepEqual(ids, ['expergo', 'tcs', 'leopards', 'dhl', 'fedex']);

    const booked = await inject(built, token, 'POST', '/api/couriers/book', {
      preset: 'expergo',
      credentials: { apiKey: 'test-key' },
      shipment: {
        sender: { name: 'Warehouse', phone: '+971500000001', address: 'Street 1', city: 'Dubai', country: 'AE' },
        receiver: { name: 'Sara', phone: '+971500000002', address: 'Flat 9', city: 'Abu Dhabi', country: 'AE' },
        weightKg: 1.5,
        codAmount: 199,
        currency: 'AED',
      },
    });
    assert.equal(booked.statusCode, 201, JSON.stringify(booked.body));
    assert.equal(booked.body.awb, 'EXP-9001');
    assert.equal(booked.body.labelUrl, 'https://labels.example/EXP-9001.pdf');

    const tracked = await inject(built, token, 'GET', '/api/couriers/track/expergo/EXP-9001');
    assert.equal(tracked.statusCode, 200, JSON.stringify(tracked.body));
    assert.equal(tracked.body.status, 'Out for delivery');
    assert.equal(tracked.body.delivered, false);
    assert.equal((tracked.body.events as unknown[]).length, 1);

    const unknown = await inject(built, token, 'POST', '/api/couriers/book', {
      preset: 'nope',
      shipment: {
        sender: { name: 'A', phone: '1', address: 'x', city: 'y', country: 'AE' },
        receiver: { name: 'B', phone: '2', address: 'x', city: 'y', country: 'AE' },
        weightKg: 1,
      },
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.body.error, 'unknown_preset');
  });
});

describe('daily CEO digest (§7 template 10)', () => {
  it('aggregates orders into JSON totals and renders a real PDF', async (t) => {
    const built = await makeApi(t);
    const token = await claimOwner(built);

    await inject(built, token, 'POST', '/api/orders', {
      channel: 'shopify',
      items: [{ sku: 'WIDGET-1', name: 'Widget', qty: 2, unitPrice: 500 }],
    });
    await inject(built, token, 'POST', '/api/orders', {
      channel: 'daraz',
      items: [{ sku: 'WIDGET-1', name: 'Widget', qty: 1, unitPrice: 500 }],
    });
    await inject(built, token, 'POST', '/api/orders', {
      channel: 'local',
      status: 'returned',
      items: [{ sku: 'GADGET-9', name: 'Gadget', qty: 1, unitPrice: 300 }],
    });

    const json = await inject(built, token, 'POST', '/api/digest/generate?format=json', {});
    assert.equal(json.statusCode, 200, JSON.stringify(json.body));
    assert.equal(json.body.digest.orders, 3);
    assert.equal(json.body.digest.revenue, 1500);
    assert.deepEqual(json.body.digest.returns, { count: 1, total: 300 });
    assert.equal(json.body.digest.topSkus[0].sku, 'WIDGET-1');
    assert.equal(json.body.digest.topSkus[0].qty, 3);
    assert.equal(json.body.digest.topSkus[0].revenue, 1500);

    const pdf = await built.app.inject({
      method: 'POST',
      url: '/api/digest/generate',
      headers: auth(token),
      payload: {},
    });
    assert.equal(pdf.statusCode, 200);
    assert.match(pdf.headers['content-type'] as string, /application\/pdf/);
    assert.equal(pdf.rawPayload.subarray(0, 5).toString('latin1'), '%PDF-');
  });
});

describe('encrypted backups (§7.6)', () => {
  it('round-trips: create -> wipe -> restore brings every store back', async (t) => {
    const built = await makeApi(t);
    const token = await claimOwner(built);

    await inject(built, token, 'POST', '/api/customers', {
      name: 'Backup Buyer',
      phone: '+923009998888',
      totalOrders: 2,
      totalSpent: 2000,
    });
    await inject(built, token, 'POST', '/api/catalog/sku-mappings', {
      masterSku: 'BACKUP-1',
      shopifySku: 'SHOP-B1',
      stock: { shopify: 4, daraz: 4, local: 4 },
    });
    await inject(built, token, 'POST', '/api/payments/verify-tid', {
      tid: 'BANK-123456',
      amount: 2000,
      orderId: 'ORD-B1',
      channel: 'bank',
    });

    const created = await inject(built, token, 'POST', '/api/backups/create', {});
    assert.equal(created.statusCode, 201, JSON.stringify(created.body).slice(0, 200));
    assert.equal(created.body.format, 'code-brothers-backup/v1');
    assert.equal(created.body.counts.customers, 1);
    assert.equal(created.body.counts.skuMappings, 1);
    assert.equal(created.body.counts.paymentTids, 1);
    const bundle = created.body.bundle as string;
    assert.ok(bundle.length > 100);
    assert.ok(!bundle.includes('Backup Buyer'), 'bundle is encrypted, not plaintext JSON');

    built.ops.clearAll();
    const wiped = await inject(built, token, 'GET', '/api/customers');
    assert.equal((wiped.body.customers as unknown[]).length, 0);

    const restored = await inject(built, token, 'POST', '/api/backups/restore', { bundle });
    assert.equal(restored.statusCode, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.restored, true);
    assert.equal(restored.body.counts.customers, 1);

    const customers = await inject(built, token, 'GET', '/api/customers');
    const rows = customers.body.customers as Array<{ name: string; phone: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Backup Buyer');
    assert.equal(rows[0].phone, '+923009998888');

    const mappings = await inject(built, token, 'GET', '/api/catalog/sku-mappings');
    assert.equal((mappings.body.mappings as unknown[]).length, 1);
    const tids = await inject(built, token, 'GET', '/api/payments/tids');
    assert.equal((tids.body.tids as unknown[]).length, 1);

    const garbage = await inject(built, token, 'POST', '/api/backups/restore', { bundle: 'not-a-backup' });
    assert.equal(garbage.statusCode, 400);
  });
});
