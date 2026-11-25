import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  createTestNodeContext,
  evaluateExpression,
  renderTemplate,
  type NodeContext,
} from '@code-brothers/node-sdk';
import { cronTriggerNode } from './nodes/cron-trigger.js';
import { httpRequestNode } from './nodes/http-request.js';
import { evaluateCondition, ifNode } from './nodes/if.js';
import { loopNode } from './nodes/loop.js';
import { setDataNode } from './nodes/set-data.js';
import { switchNode } from './nodes/switch.js';
import { MAX_WAIT_MS, waitNode } from './nodes/wait.js';
import { webhookTriggerNode } from './nodes/webhook-trigger.js';
import { SsrfError } from './ssrf.js';

/** Test context wired with the real expression engine, like the engine does. */
function makeCtx(
  parameters: Record<string, unknown> = {},
  extra: Parameters<typeof createTestNodeContext>[0] = {},
): NodeContext {
  const { ctx } = createTestNodeContext({
    parameters,
    evaluateExpression: (source, itemJson) =>
      evaluateExpression(source, { $json: itemJson ?? {}, $node: {}, $vars: {} }),
    renderTemplate: (template, itemJson) =>
      renderTemplate(template, { $json: itemJson ?? {}, $node: {}, $vars: {} }),
    ...extra,
  });
  return ctx;
}

describe('IF node + evaluateCondition', () => {
  it('supports all operators', () => {
    assert.equal(evaluateCondition(5, 'equals', 5), true);
    assert.equal(evaluateCondition('5', 'equals', 5), true); // numeric coercion
    assert.equal(evaluateCondition(5, 'notEquals', 6), true);
    assert.equal(evaluateCondition('hello world', 'contains', 'world'), true);
    assert.equal(evaluateCondition([1, 2, 3], 'contains', 2), true);
    assert.equal(evaluateCondition({ a: 1 }, 'contains', 'a'), true);
    assert.equal(evaluateCondition(10, 'gt', 5), true);
    assert.equal(evaluateCondition(3, 'lt', 5), true);
    assert.equal(evaluateCondition('x', 'exists', undefined), true);
    assert.equal(evaluateCondition(null, 'exists', undefined), false);
    assert.equal(evaluateCondition(undefined, 'exists', undefined), false);
  });

  it('routes items to true/false branches', async () => {
    const ctx = makeCtx({
      left: '{{ $json.age }}',
      operator: 'gt',
      right: 17,
    });
    const [truthy, falsy] = await ifNode.execute(ctx, [
      { json: { age: 21 } },
      { json: { age: 12 } },
      { json: { age: 18 } },
    ]);
    assert.deepEqual(
      truthy?.map((i) => i.json.age),
      [21, 18],
    );
    assert.deepEqual(
      falsy?.map((i) => i.json.age),
      [12],
    );
  });
});

describe('Switch node', () => {
  it('routes to the matching case and the default branch', async () => {
    const ctx = makeCtx({
      value: '{{ $json.status }}',
      cases: [{ match: 'paid' }, { match: 'pending' }],
    });
    const branches = await switchNode.execute(ctx, [
      { json: { status: 'paid' } },
      { json: { status: 'pending' } },
      { json: { status: 'refunded' } },
      { json: { status: 'paid' } },
    ]);
    assert.equal(branches.length, 3);
    assert.equal(branches[0]?.length, 2);
    assert.equal(branches[1]?.length, 1);
    assert.equal(branches[2]?.length, 1); // default
    assert.equal(branches[2]?.[0]?.json.status, 'refunded');
  });

  it('throws without a cases array', async () => {
    const ctx = makeCtx({ value: '{{ $json.x }}' });
    await assert.rejects(() => switchNode.execute(ctx, [{ json: {} }]), /cases/);
  });
});

describe('Loop node', () => {
  it('expands an array field into one item per element', async () => {
    const ctx = makeCtx({ arrayField: 'items' });
    const [out] = await loopNode.execute(ctx, [
      { json: { items: [{ sku: 'A' }, { sku: 'B' }, 7] } },
    ]);
    assert.equal(out?.length, 3);
    assert.deepEqual(out?.[0]?.json, { sku: 'A' });
    assert.deepEqual(out?.[2]?.json, { value: 7 });
  });

  it('throws when the field is not an array', async () => {
    const ctx = makeCtx({ arrayField: 'items' });
    await assert.rejects(
      () => loopNode.execute(ctx, [{ json: { items: 'nope' } }]),
      /not an array|to be an array/,
    );
  });
});

describe('Wait node', () => {
  it('sleeps through ctx.sleep and passes items through', async () => {
    const { ctx, sleeps } = createTestNodeContext({
      parameters: { durationMs: 250 },
    });
    const input = [{ json: { a: 1 } }];
    const [out] = await waitNode.execute(ctx, input);
    assert.deepEqual(sleeps, [250]);
    assert.deepEqual(out, input);
  });

  it('caps excessive durations at MAX_WAIT_MS', async () => {
    const { ctx, sleeps } = createTestNodeContext({
      parameters: { durationMs: MAX_WAIT_MS * 100 },
    });
    await waitNode.execute(ctx, [{ json: {} }]);
    assert.deepEqual(sleeps, [MAX_WAIT_MS]);
  });

  it('supports seconds', async () => {
    const { ctx, sleeps } = createTestNodeContext({
      parameters: { seconds: 2 },
    });
    await waitNode.execute(ctx, [{ json: {} }]);
    assert.deepEqual(sleeps, [2000]);
  });
});

describe('Set Data node', () => {
  it('maps fields with typed expressions', async () => {
    const ctx = makeCtx({
      assignments: [
        { name: 'fullName', value: '{{ $json.first }} {{ $json.last }}' },
        { name: 'doublePrice', value: '{{ $json.price * 2 }}' },
      ],
    });
    const [out] = await setDataNode.execute(ctx, [
      { json: { first: 'Ada', last: 'Lovelace', price: 10 } },
    ]);
    assert.equal(out?.[0]?.json.fullName, 'Ada Lovelace');
    assert.equal(out?.[0]?.json.doublePrice, 20);
    assert.equal(out?.[0]?.json.price, 10); // original kept
  });

  it('keepOnlySet drops unassigned fields; fields-map form works', async () => {
    const ctx = makeCtx({
      fields: { renamed: '{{ $json.old }}' },
      keepOnlySet: true,
    });
    const [out] = await setDataNode.execute(ctx, [
      { json: { old: 'x', other: 'y' } },
    ]);
    assert.deepEqual(out?.[0]?.json, { renamed: 'x' });
  });
});

describe('Cron Trigger node', () => {
  it('emits expression + next run for a valid cron', async () => {
    const ctx = makeCtx({ expression: '0 9 * * *' });
    const [out] = await cronTriggerNode.execute(ctx, []);
    const json = out?.[0]?.json as { expression: string; nextRun: string };
    assert.equal(json.expression, '0 9 * * *');
    assert.ok(new Date(json.nextRun).getTime() > Date.now());
  });

  it('rejects an invalid cron expression', async () => {
    const ctx = makeCtx({ expression: 'not a cron' });
    await assert.rejects(() => cronTriggerNode.execute(ctx, []), /Cron/);
  });
});

describe('Webhook Trigger node', () => {
  it('unwraps the request body to the top level, keeping metadata under webhook', async () => {
    const ctx = makeCtx({});
    const [out] = await webhookTriggerNode.execute(ctx, [
      {
        json: {
          method: 'post',
          path: '/hooks/order',
          headers: { 'x-signature': 'abc' },
          query: { src: 'shop' },
          body: { orderId: 5 },
        },
      },
    ]);
    const json = out?.[0]?.json as {
      orderId: number;
      webhook: { method: string; path: string };
    };
    assert.equal(json.orderId, 5);
    assert.equal(json.webhook.method, 'POST');
    assert.equal(json.webhook.path, '/hooks/order');
  });

  it('passes a manual-run payload through unchanged', async () => {
    const ctx = makeCtx({});
    const [out] = await webhookTriggerNode.execute(ctx, [
      { json: { messageType: 'text', text: 'red shoes' } },
    ]);
    const json = out?.[0]?.json as { messageType: string; text: string };
    assert.equal(json.messageType, 'text');
    assert.equal(json.text, 'red shoes');
  });

  it('rejects a mismatched method when one is configured', async () => {
    const ctx = makeCtx({ method: 'GET' });
    await assert.rejects(
      () => webhookTriggerNode.execute(ctx, [{ json: { method: 'POST' } }]),
      /method mismatch/,
    );
  });
});

describe('HTTP Request node', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/users/')) {
        const id = req.url.split('/').pop();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: Number(id), name: 'Ada' }));
        return;
      }
      if (req.url === '/echo') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, body }));
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fetches and parses JSON per item, rendering the URL template', async () => {
    const ctx = makeCtx({ method: 'GET', url: `${baseUrl}/users/{{ $json.id }}` });
    const [out] = await httpRequestNode.execute(ctx, [{ json: { id: 7 } }]);
    const json = out?.[0]?.json as {
      statusCode: number;
      body: { id: number; name: string };
    };
    assert.equal(json.statusCode, 200);
    assert.equal(json.body.id, 7);
    assert.equal(json.body.name, 'Ada');
  });

  it('deep-renders {{ }} expressions inside an object body per item', async () => {
    const ctx = makeCtx({
      method: 'POST',
      url: `${baseUrl}/echo`,
      body: { query: '{{ $json.question }}', limit: 3, nested: { tag: '{{ $json.tag }}' } },
    });
    const [out] = await httpRequestNode.execute(ctx, [
      { json: { question: 'red shoes', tag: 'sale' } },
    ]);
    const json = out?.[0]?.json as {
      statusCode: number;
      body: { body: string };
    };
    assert.equal(json.statusCode, 200);
    // The /echo fixture returns the raw request body as a string.
    const echoed = JSON.parse(json.body.body) as {
      query: string;
      limit: number;
      nested: { tag: string };
    };
    assert.equal(echoed.query, 'red shoes');
    assert.equal(echoed.limit, 3);
    assert.equal(echoed.nested.tag, 'sale');
  });

  it('throws on HTTP errors by default', async () => {
    const ctx = makeCtx({ method: 'GET', url: `${baseUrl}/missing` });
    await assert.rejects(
      () => httpRequestNode.execute(ctx, [{ json: {} }]),
      /HTTP 404/,
    );
  });

  it('surfaces guard rejections from ctx.fetch (SSRF)', async () => {
    const ctx = makeCtx(
      { method: 'GET', url: 'http://127.0.0.1:1/secret' },
      {
        fetchImpl: async () => {
          throw new SsrfError('Blocked request to private IP 127.0.0.1');
        },
      },
    );
    await assert.rejects(
      () => httpRequestNode.execute(ctx, [{ json: {} }]),
      SsrfError,
    );
  });
});

describe('Aggregate node', () => {
  it('counts items and sums the first matching amount field per item', async () => {
    const { ctx } = createTestNodeContext({
      parameters: {
        sumFields: 'total_price,total,price,amount',
        countName: 'totalOrders',
        sumName: 'totalRevenue',
        textTemplate: 'Daily digest: {{ $json.totalOrders }} orders, revenue {{ $json.totalRevenue }}.',
      },
    });
    const { aggregateNode } = await import('./nodes/aggregate.js');
    const [out] = await aggregateNode.execute(ctx, [
      { json: { total_price: '120.50' } },
      { json: { total: 30 } },
      { json: { price: 9.99 } },
      { json: { note: 'no amount field' } },
    ]);
    const json = out?.[0]?.json as Record<string, unknown>;
    assert.equal(json.totalOrders, 4);
    assert.equal(json.totalRevenue, 160.49);
    assert.equal(json.digestText, 'Daily digest: 4 orders, revenue 160.49.');
  });
});
