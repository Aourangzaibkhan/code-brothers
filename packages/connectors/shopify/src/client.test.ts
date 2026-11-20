import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShopifyClient, ShopifyApiError } from './client.js';

interface Captured { url: string; init: RequestInit | undefined }
function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Captured[] = [];
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
function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}
function bodyOf(init?: RequestInit): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
}

const creds = { shop: 'mystore.myshopify.com', accessToken: 'shpat_test_token' };

test('getOrders: REST path, method, query and auth header', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ orders: [{ id: 1 }, { id: 2 }] }));
  const client = new ShopifyClient({ ...creds, fetch: fetchImpl });
  const orders = await client.getOrders({ status: 'open', limit: 10 });
  assert.equal(orders.length, 2);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://mystore.myshopify.com/admin/api/2024-10/orders.json');
  assert.equal(url.searchParams.get('status'), 'open');
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(headersOf(calls[0].init)['X-Shopify-Access-Token'], 'shpat_test_token');
});

test('getProducts / getProduct / createProduct / updateProduct paths and bodies', async () => {
  const { calls, fetchImpl } = stubFetch((url) => {
    if (url.includes('/products/')) return jsonResponse({ product: { id: 7, title: 'Hat' } });
    return jsonResponse({ products: [{ id: 7 }], product: { id: 7, title: 'Hat' } });
  });
  const client = new ShopifyClient({ ...creds, fetch: fetchImpl });
  const products = await client.getProducts({ limit: 5 });
  assert.equal(products.length, 1);
  assert.ok(calls[0].url.includes('/products.json'));
  await client.getProduct(7);
  assert.ok(calls[1].url.includes('/products/7.json'));
  assert.equal(calls[1].init?.method, 'GET');
  const created = await client.createProduct({ title: 'Hat' }) as Record<string, unknown>;
  assert.equal(created.title, 'Hat');
  assert.equal(calls[2].init?.method, 'POST');
  assert.deepEqual(bodyOf(calls[2].init), { product: { title: 'Hat' } });
  await client.updateProduct(7, { title: 'Cap' });
  assert.equal(calls[3].init?.method, 'PUT');
  assert.deepEqual(bodyOf(calls[3].init), { product: { id: 7, title: 'Cap' } });
  for (const c of calls) assert.equal(headersOf(c.init)['X-Shopify-Access-Token'], 'shpat_test_token');
});

test('createDraftOrder posts {draft_order} to /draft_orders.json', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ draft_order: { id: 99 } }));
  const client = new ShopifyClient({ ...creds, fetch: fetchImpl });
  const draft = await client.createDraftOrder({ email: 'a@b.c', line_items: [{ variant_id: 1, quantity: 2 }] }) as Record<string, unknown>;
  assert.equal(draft.id, 99);
  assert.ok(calls[0].url.includes('/draft_orders.json'));
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(bodyOf(calls[0].init), { draft_order: { email: 'a@b.c', line_items: [{ variant_id: 1, quantity: 2 }] } });
});

test('createFulfillment builds fulfillment-orders flow shape', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ fulfillment: { id: 55 } }));
  const client = new ShopifyClient({ ...creds, fetch: fetchImpl });
  await client.createFulfillment(123, {
    fulfillmentOrderId: 456,
    lineItems: [{ id: 789, quantity: 1 }],
    trackingNumber: 'TRK1',
    trackingCompany: 'DHL',
    notifyCustomer: true,
  });
  assert.ok(calls[0].url.includes('/fulfillments.json'));
  assert.deepEqual(bodyOf(calls[0].init), {
    fulfillment: {
      line_items_by_fulfillment_order: [
        { fulfillment_order_id: 456, fulfillment_order_line_items: [{ id: 789, quantity: 1 }] },
      ],
      tracking_info: { number: 'TRK1', company: 'DHL' },
      notify_customer: true,
    },
  });
});

test('inventory: get levels query, set and adjust bodies', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ inventory_levels: [{ available: 3 }], inventory_level: { available: 10 } }));
  const client = new ShopifyClient({ ...creds, fetch: fetchImpl });
  const levels = await client.getInventoryLevels({ inventoryItemIds: [1, 2], locationIds: [9] });
  assert.equal(levels.length, 1);
  const u = new URL(calls[0].url);
  assert.ok(u.pathname.endsWith('/inventory_levels.json'));
  assert.equal(u.searchParams.get('inventory_item_ids'), '1,2');
  assert.equal(u.searchParams.get('location_ids'), '9');

  await client.setInventoryLevel({ locationId: 9, inventoryItemId: 1, available: 10 });
  assert.ok(calls[1].url.includes('/inventory_levels/set.json'));
  assert.equal(calls[1].init?.method, 'POST');
  assert.deepEqual(bodyOf(calls[1].init), { location_id: 9, inventory_item_id: 1, available: 10 });

  await client.adjustInventoryLevel({ locationId: 9, inventoryItemId: 1, availableAdjustQuantity: -2 });
  assert.ok(calls[2].url.includes('/inventory_levels/adjust.json'));
  assert.deepEqual(bodyOf(calls[2].init), { location_id: 9, inventory_item_id: 1, available_adjustment: -2 });
});

test('updateOrder sends tags/note fields', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ order: { id: 5, tags: 'vip' } }));
  const client = new ShopifyClient({ ...creds, fetch: fetchImpl });
  await client.updateOrder(5, { tags: 'vip', note: 'hello' });
  assert.equal(calls[0].init?.method, 'PUT');
  assert.deepEqual(bodyOf(calls[0].init), { order: { id: 5, tags: 'vip', note: 'hello' } });
});

test('graphql posts {query, variables} and returns data', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ data: { shop: { name: 'My Store' } } }));
  const client = new ShopifyClient({ ...creds, fetch: fetchImpl });
  const data = await client.graphql<{ shop: { name: string } }>('query { shop { name } }', { first: 3 });
  assert.equal(data.shop.name, 'My Store');
  assert.ok(calls[0].url.endsWith('/admin/api/2024-10/graphql.json'));
  assert.deepEqual(bodyOf(calls[0].init), { query: 'query { shop { name } }', variables: { first: 3 } });
});

test('graphql throws on top-level errors array', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ errors: [{ message: 'bad field' }] }));
  const client = new ShopifyClient({ ...creds, fetch: fetchImpl });
  await assert.rejects(() => client.graphql('{ nope }'), /Shopify GraphQL errors/);
});

test('non-2xx throws ShopifyApiError with status and body', async () => {
  const { fetchImpl } = stubFetch(() => new Response('{"errors":"Not Found"}', { status: 404 }));
  const client = new ShopifyClient({ ...creds, fetch: fetchImpl });
  await assert.rejects(
    () => client.getOrder(999),
    (err: unknown) => {
      assert.ok(err instanceof ShopifyApiError);
      assert.equal(err.status, 404);
      assert.match(err.body, /Not Found/);
      return true;
    },
  );
});

test('custom apiVersion and baseUrl override are honoured', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ orders: [] }));
  const client = new ShopifyClient({ ...creds, fetch: fetchImpl, apiVersion: '2025-01' });
  await client.getOrders();
  assert.ok(calls[0].url.includes('/admin/api/2025-01/orders.json'));
  const client2 = new ShopifyClient({ ...creds, fetch: fetchImpl, baseUrl: 'https://example.test/custom' });
  await client2.getOrders();
  assert.ok(calls[1].url.startsWith('https://example.test/custom/orders.json'));
});
