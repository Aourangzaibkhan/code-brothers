import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { WooCommerceApiError, WooCommerceClient } from './woocommerce.js';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(
  responseBody: unknown,
  status = 200,
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(
      typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody),
      { status, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, calls };
}

describe('WooCommerceClient — HTTPS Basic auth', () => {
  it('sends Basic base64(ck:cs) and hits the versioned base URL', async () => {
    const { fetchImpl, calls } = stubFetch([{ id: 1, status: 'completed' }]);
    const client = new WooCommerceClient({
      storeUrl: 'https://shop.example.com/',
      consumerKey: 'ck_abc',
      consumerSecret: 'cs_xyz',
      fetch: fetchImpl,
    });
    const orders = await client.getOrders<{ id: number }[]>({ status: 'completed' });
    assert.equal(orders[0]?.id, 1);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      'https://shop.example.com/wp-json/wc/v3/orders?status=completed',
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    const expectedBasic = Buffer.from('ck_abc:cs_xyz', 'utf8').toString('base64');
    assert.equal(headers.Authorization, `Basic ${expectedBasic}`);
  });

  it('updateProductStock PUTs { stock_quantity, manage_stock: true }', async () => {
    const { fetchImpl, calls } = stubFetch({ id: 9, stock_quantity: 25 });
    const client = new WooCommerceClient({
      storeUrl: 'https://shop.example.com',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      fetch: fetchImpl,
    });
    await client.updateProductStock(9, 25);
    assert.equal(calls[0]?.init.method, 'PUT');
    assert.equal(calls[0]?.url, 'https://shop.example.com/wp-json/wc/v3/products/9');
    assert.deepEqual(JSON.parse(calls[0]?.init.body as string), {
      stock_quantity: 25,
      manage_stock: true,
    });
  });

  it('createOrder POSTs the order body', async () => {
    const { fetchImpl, calls } = stubFetch({ id: 100 }, 201);
    const client = new WooCommerceClient({
      storeUrl: 'https://shop.example.com',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      fetch: fetchImpl,
    });
    const created = await client.createOrder<{ id: number }>({
      payment_method: 'cod',
      line_items: [{ product_id: 1, quantity: 2 }],
    });
    assert.equal(created.id, 100);
    assert.equal(calls[0]?.init.method, 'POST');
    assert.equal(calls[0]?.url, 'https://shop.example.com/wp-json/wc/v3/orders');
  });
});

describe('WooCommerceClient — HTTP one-legged OAuth 1.0a signing', () => {
  it('produces the independently computed HMAC-SHA256 signature', async () => {
    const { fetchImpl, calls } = stubFetch([]);
    const client = new WooCommerceClient({
      storeUrl: 'http://example.com',
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      fetch: fetchImpl,
      nonceFn: () => 'testnonce123',
      now: () => 1700000000,
    });
    await client.getOrders({ status: 'completed' });

    const url = new URL(calls[0]?.url ?? '');
    assert.equal(
      `${url.origin}${url.pathname}`,
      'http://example.com/wp-json/wc/v3/orders',
    );
    assert.equal(url.searchParams.get('oauth_consumer_key'), 'ck_test');
    assert.equal(url.searchParams.get('oauth_nonce'), 'testnonce123');
    assert.equal(url.searchParams.get('oauth_timestamp'), '1700000000');
    assert.equal(url.searchParams.get('oauth_signature_method'), 'HMAC-SHA256');
    assert.equal(url.searchParams.get('status'), 'completed');
    // No Basic auth header on plain-http (OAuth replaces it).
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined);

    // Expectation computed INDEPENDENTLY: the base string below is written
    // out by hand from the documented rules —
    //   METHOD & encode(url-without-query) & encode(sorted-normalized-params)
    // with params sorted by encoded key:
    //   oauth_consumer_key, oauth_nonce, oauth_signature_method,
    //   oauth_timestamp, status
    // and signed with key "consumerSecret&" via node:crypto directly.
    // The client's own signer is NOT used to build this expectation.
    const handWrittenBaseString =
      'GET' +
      '&http%3A%2F%2Fexample.com%2Fwp-json%2Fwc%2Fv3%2Forders' +
      '&oauth_consumer_key%3Dck_test%26oauth_nonce%3Dtestnonce123' +
      '%26oauth_signature_method%3DHMAC-SHA256%26oauth_timestamp%3D1700000000' +
      '%26status%3Dcompleted';
    const expectedSignature = createHmac('sha256', 'cs_test&')
      .update(handWrittenBaseString)
      .digest('base64');
    assert.equal(url.searchParams.get('oauth_signature'), expectedSignature);
  });
});

describe('WooCommerceClient — errors', () => {
  it('throws WooCommerceApiError carrying the Woo { code, message } shape', async () => {
    const { fetchImpl } = stubFetch(
      { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' },
      404,
    );
    const client = new WooCommerceClient({
      storeUrl: 'https://shop.example.com',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      fetch: fetchImpl,
    });
    await assert.rejects(
      () => client.getOrder(999),
      (error: unknown) => {
        assert.ok(error instanceof WooCommerceApiError);
        assert.equal(error.code, 'rest_no_route');
        assert.equal(error.status, 404);
        assert.match(error.message, /No route was found/);
        return true;
      },
    );
  });
});
