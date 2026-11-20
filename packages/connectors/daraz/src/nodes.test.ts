import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestNodeContext, NodeRegistry } from '@code-brothers/node-sdk';
import { darazGetOrdersNode, darazUpdateStockNode, registerDarazNodes, nodes } from './nodes.js';
import { signDarazRequest } from './sign.js';

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    return handler(u, init);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const credentials = {
  darazApi: { appKey: '123456', appSecret: 'test-app-secret', accessToken: 'test-token', country: 'pk' },
};

test('registerDarazNodes registers all nodes', () => {
  const registry = new NodeRegistry();
  registerDarazNodes(registry);
  assert.equal(registry.size, nodes.length);
  assert.ok(registry.has('daraz.getOrders'));
  assert.ok(registry.has('daraz.updateStock'));
});

test('darazGetOrders executes via test context with a verifiably signed request', async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse({ code: '0', data: { orders: [{ order_id: 1 }, { order_id: 2 }] } }),
  );
  const { ctx } = createTestNodeContext({
    parameters: { createdAfter: '2026-01-01T00:00:00+08:00', limit: 10 },
    credentials,
    fetchImpl,
  });
  const out = await darazGetOrdersNode.execute(ctx, []);
  assert.equal(out[0].length, 2);
  assert.deepEqual(out[0][0].json, { order_id: 1 });
  const url = new URL(calls[0].url);
  assert.ok(url.pathname.endsWith('/orders/get'));
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) params[k] = v;
  assert.equal(params.app_key, '123456');
  assert.equal(params.created_after, '2026-01-01T00:00:00+08:00');
  // Signature verifies with the client secret via the exported signer —
  // note ctx supplies a real clock, so recompute (not the fixed vector).
  assert.equal(signDarazRequest('/orders/get', params, 'test-app-secret'), params.sign);
});

test('darazUpdateStock sends the XML payload for the SKU', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ code: '0', data: { success: true } }));
  const { ctx } = createTestNodeContext({
    parameters: { sellerSku: 'SKU-77', quantity: 15 },
    credentials,
    fetchImpl,
  });
  const out = await darazUpdateStockNode.execute(ctx, []);
  assert.equal((out[0][0].json as Record<string, unknown>).sellerSku, 'SKU-77');
  assert.equal((out[0][0].json as Record<string, unknown>).quantity, 15);
  assert.equal(calls[0].init?.method, 'POST');
  const payload = new URL(calls[0].url).searchParams.get('payload') ?? '';
  assert.ok(payload.includes('<SellerSku>SKU-77</SellerSku>'));
  assert.ok(payload.includes('<Quantity>15</Quantity>'));
});

test('nodes throw when credentials are missing', async () => {
  const { ctx } = createTestNodeContext({ parameters: {}, credentials: {} });
  await assert.rejects(() => darazGetOrdersNode.execute(ctx, []), /darazApi/);
});
