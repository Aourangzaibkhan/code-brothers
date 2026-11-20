import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DarazClient, DarazApiError } from './client.js';
import { signDarazRequest } from './sign.js';

const FIXED_NOW = 1700000000000;
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
function makeClient(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new DarazClient({
    appKey: '123456',
    appSecret: 'test-app-secret',
    accessToken: 'test-token',
    fetch: fetchImpl,
    now: () => FIXED_NOW,
    ...extra,
  });
}
function assertSignVerifies(urlStr: string, apiPath: string) {
  const url = new URL(urlStr);
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) params[k] = v;
  const sign = params.sign;
  assert.ok(sign, 'sign param present');
  assert.equal(signDarazRequest(apiPath, params, 'test-app-secret'), sign);
  return params;
}

test('apiCall URL contains app_key/timestamp/sign_method/access_token and sign verifies', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ code: '0', data: { orders: [{ order_id: 1 }] } }));
  const client = makeClient(fetchImpl);
  const data = await client.getOrders({ status: 'pending', limit: 10 }) as { orders: unknown[] };
  assert.equal(data.orders.length, 1);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.daraz.pk/rest/orders/get');
  const params = assertSignVerifies(calls[0].url, '/orders/get');
  assert.equal(params.app_key, '123456');
  assert.equal(params.timestamp, String(FIXED_NOW));
  assert.equal(params.sign_method, 'sha256');
  assert.equal(params.access_token, 'test-token');
  assert.equal(params.status, 'pending');
  assert.equal(params.limit, '10');
  assert.equal(calls[0].init?.method, 'GET');
});

test('country selects the right base URL; baseUrl override wins', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ code: '0', data: [] }));
  await makeClient(fetchImpl, { country: 'bd' }).getOrders();
  assert.ok(calls[0].url.startsWith('https://api.daraz.com.bd/rest/orders/get'));
  await makeClient(fetchImpl, { baseUrl: 'https://example.test/rest' }).getOrders();
  assert.ok(calls[1].url.startsWith('https://example.test/rest/orders/get'));
});

test('getOrderItems hits /orders/items/get with order_id', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ code: '0', data: { order_items: [] } }));
  const client = makeClient(fetchImpl);
  await client.getOrderItems(987);
  const params = assertSignVerifies(calls[0].url, '/orders/items/get');
  assert.equal(params.order_id, '987');
});

test("non-'0' Daraz code throws DarazApiError with code and message", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ code: 'IllegalAccessToken', message: 'token expired' }));
  const client = makeClient(fetchImpl);
  await assert.rejects(
    () => client.getOrders(),
    (err: unknown) => {
      assert.ok(err instanceof DarazApiError);
      assert.equal(err.code, 'IllegalAccessToken');
      assert.match(err.message, /token expired/);
      return true;
    },
  );
});

test('updateProductItem sends payload param with SellerSku + Quantity XML (POST, signed)', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ code: '0', data: { success: true } }));
  const client = makeClient(fetchImpl);
  await client.updateProductItem({ sellerSku: 'SKU-001', quantity: 42 });
  assert.equal(calls[0].init?.method, 'POST');
  assert.ok(calls[0].url.includes('/product/item/update'));
  const params = assertSignVerifies(calls[0].url, '/product/item/update');
  const payload = params.payload;
  assert.ok(payload.startsWith('<?xml version="1.0" encoding="UTF-8"?><Request><Product><Skus><Sku>'));
  assert.ok(payload.includes('<SellerSku>SKU-001</SellerSku>'));
  assert.ok(payload.includes('<Quantity>42</Quantity>'));
  assert.ok(payload.endsWith('</Sku></Skus></Product></Request>'));
  assert.ok(!payload.includes('<Price>'), 'unprovided fields are omitted');
});

test('updateProductItem includes price/sale fields and XML-escapes values', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ code: '0', data: {} }));
  const client = makeClient(fetchImpl);
  await client.updatePrice({ sellerSku: 'A&B<1>', price: 500, salePrice: 399, saleStart: '2026-01-01', saleEnd: '2026-01-31' });
  const payload = new URL(calls[0].url).searchParams.get('payload') ?? '';
  assert.ok(payload.includes('<SellerSku>A&amp;B&lt;1&gt;</SellerSku>'));
  assert.ok(payload.includes('<Price>500</Price>'));
  assert.ok(payload.includes('<SalePrice>399</SalePrice>'));
  assert.ok(payload.includes('<SaleStartDate>2026-01-01</SaleStartDate>'));
  assert.ok(payload.includes('<SaleEndDate>2026-01-31</SaleEndDate>'));
  // updateStock wrapper delegates
  await client.updateStock('SKU-9', 3);
  const payload2 = new URL(calls[1].url).searchParams.get('payload') ?? '';
  assert.ok(payload2.includes('<SellerSku>SKU-9</SellerSku><Quantity>3</Quantity>'));
});

test('refreshAccessToken posts to the configurable auth endpoint, signed', async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 2592000 }),
  );
  const client = makeClient(fetchImpl, { authBaseUrl: 'https://auth.daraz.pk' });
  const tokens = await client.refreshAccessToken('old-refresh-token');
  assert.equal(tokens.access_token, 'new-token');
  assert.equal(tokens.expires_in, 2592000);
  assert.equal(calls[0].init?.method, 'POST');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://auth.daraz.pk/rest/oauth2/refresh_token');
  const params = assertSignVerifies(calls[0].url, '/oauth2/refresh_token');
  assert.equal(params.refresh_token, 'old-refresh-token');
});

test('refreshAccessToken default auth root derives from the REST base', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ access_token: 't' }));
  const client = makeClient(fetchImpl);
  await client.refreshAccessToken('r');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.daraz.pk/rest/oauth2/refresh_token');
});
