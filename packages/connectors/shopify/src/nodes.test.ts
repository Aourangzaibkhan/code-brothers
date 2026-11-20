import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestNodeContext, NodeRegistry } from '@code-brothers/node-sdk';
import {
  shopifyGetOrdersNode,
  shopifyCreateDraftOrderNode,
  shopifyUpdateInventoryNode,
  registerShopifyNodes,
  nodes,
} from './nodes.js';

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
const credentials = { shopifyApi: { shop: 'mystore.myshopify.com', accessToken: 'shpat_test_token' } };

test('registerShopifyNodes registers all nodes', () => {
  const registry = new NodeRegistry();
  registerShopifyNodes(registry);
  assert.equal(registry.size, nodes.length);
  assert.ok(registry.has('shopify.getOrders'));
  assert.ok(registry.has('shopify.createDraftOrder'));
  assert.ok(registry.has('shopify.updateInventory'));
});

test('shopifyGetOrders executes via test context, one item per order', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ orders: [{ id: 1 }, { id: 2 }, { id: 3 }] }));
  const { ctx } = createTestNodeContext({
    parameters: { status: 'open', limit: 25 },
    credentials,
    fetchImpl,
  });
  const out = await shopifyGetOrdersNode.execute(ctx, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 3);
  assert.deepEqual(out[0][0].json, { id: 1 });
  assert.ok(calls[0].url.includes('/orders.json'));
  assert.equal(((calls[0].init?.headers ?? {}) as Record<string, string>)['X-Shopify-Access-Token'], 'shpat_test_token');
});

test('shopifyCreateDraftOrder parses lineItemsJson parameter', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ draft_order: { id: 42 } }));
  const { ctx } = createTestNodeContext({
    parameters: { email: 'buyer@example.com', lineItemsJson: '[{"variant_id":11,"quantity":2}]' },
    credentials,
    fetchImpl,
  });
  const out = await shopifyCreateDraftOrderNode.execute(ctx, []);
  assert.equal((out[0][0].json as Record<string, unknown>).id, 42);
  const sent = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
  assert.deepEqual(sent, { draft_order: { line_items: [{ variant_id: 11, quantity: 2 }], email: 'buyer@example.com' } });
});

test('shopifyCreateDraftOrder falls back to input items when no JSON param', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ draft_order: { id: 43 } }));
  const { ctx } = createTestNodeContext({ parameters: {}, credentials, fetchImpl });
  await shopifyCreateDraftOrderNode.execute(ctx, [{ json: { variant_id: 5, quantity: 1 } }]);
  const sent = JSON.parse(String(calls[0].init?.body)) as { draft_order: { line_items: unknown[] } };
  assert.deepEqual(sent.draft_order.line_items, [{ variant_id: 5, quantity: 1 }]);
});

test('shopifyUpdateInventory sets the level', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ inventory_level: { available: 7 } }));
  const { ctx } = createTestNodeContext({
    parameters: { locationId: 101, inventoryItemId: 202, available: 7 },
    credentials,
    fetchImpl,
  });
  const out = await shopifyUpdateInventoryNode.execute(ctx, []);
  assert.equal((out[0][0].json as Record<string, unknown>).available, 7);
  assert.ok(calls[0].url.includes('/inventory_levels/set.json'));
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { location_id: 101, inventory_item_id: 202, available: 7 });
});

test('nodes throw when credentials are missing', async () => {
  const { ctx } = createTestNodeContext({ parameters: {}, credentials: {} });
  await assert.rejects(() => shopifyGetOrdersNode.execute(ctx, []), /shopifyApi/);
});
