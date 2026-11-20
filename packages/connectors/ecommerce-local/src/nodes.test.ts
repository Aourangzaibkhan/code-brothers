import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NodeRegistry, createTestNodeContext } from '@code-brothers/node-sdk';
import {
  localDbQueryNode,
  localSendWebhookNode,
  registerEcommerceLocalNodes,
  wooGetOrdersNode,
} from './nodes.js';
import { SqlStoreConnector } from './sql.js';
import { verifyWebhookSignature } from './webhook.js';

describe('localDbQuery node (via ctx.variables.sqlConnector hook)', () => {
  it('runs the query through the injected connector and outputs rows', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const connector = new SqlStoreConnector({
      queryable: {
        async query(text, values) {
          calls.push({ text, values: values ?? [] });
          return { rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }] };
        },
      },
    });
    const { ctx } = createTestNodeContext({
      parameters: {
        sql: 'SELECT * FROM "customers" WHERE "id" > $1',
        valuesJson: '[0]',
      },
      variables: { sqlConnector: connector },
    });
    const [out] = await localDbQueryNode.execute(ctx, [{ json: {} }]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.values, [0]);
    assert.equal(out?.length, 2);
    assert.deepEqual(out?.[0]?.json, { id: 1, name: 'Ada' });
    assert.deepEqual(out?.[1]?.json, { id: 2, name: 'Grace' });
  });
});

describe('localSendWebhook node (stub fetch)', () => {
  it('emits each input item with a verifiable signature', async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const { ctx } = createTestNodeContext({
      parameters: { url: 'https://hooks.example.com/x', event: 'order.created' },
      credentials: { localStore: { webhookSecret: 'node-secret' } },
      fetchImpl: async (url, init) => {
        sent.push({ url: String(url), init: init ?? {} });
        return new Response('delivered', { status: 200 });
      },
    });
    const [out] = await localSendWebhookNode.execute(ctx, [
      { json: { orderId: 55 } },
    ]);
    assert.equal(sent.length, 1);
    const headers = sent[0]?.init.headers as Record<string, string>;
    const body = sent[0]?.init.body as string;
    assert.equal(
      verifyWebhookSignature(body, headers['X-CodeBrothers-Signature'], 'node-secret'),
      true,
    );
    assert.equal(out?.[0]?.json.status, 200);
    assert.equal(out?.[0]?.json.event, 'order.created');
    assert.equal(out?.[0]?.json.responseBody, 'delivered');
  });
});

describe('wooGetOrders node (stub fetch)', () => {
  it('maps credential + parameters into a WooCommerce request', async () => {
    const urls: string[] = [];
    const { ctx } = createTestNodeContext({
      parameters: { status: 'processing', perPage: 5 },
      credentials: {
        localStore: {
          storeUrl: 'https://shop.example.com',
          consumerKey: 'ck_1',
          consumerSecret: 'cs_1',
        },
      },
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify([{ id: 11 }, { id: 12 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const [out] = await wooGetOrdersNode.execute(ctx, [{ json: {} }]);
    assert.equal(
      urls[0],
      'https://shop.example.com/wp-json/wc/v3/orders?status=processing&per_page=5',
    );
    assert.equal(out?.length, 2);
    assert.deepEqual(out?.[0]?.json, { id: 11 });
    assert.deepEqual(out?.[1]?.json, { id: 12 });
  });
});

describe('registerEcommerceLocalNodes', () => {
  it('registers exactly the three local node types', () => {
    const registry = registerEcommerceLocalNodes(new NodeRegistry());
    assert.deepEqual(registry.types().sort(), [
      'local.dbQuery',
      'local.sendWebhook',
      'local.wooGetOrders',
    ]);
  });
});
