import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  MemoryNodeLogger,
  defineNode,
} from '@code-brothers/node-sdk';
import { WorkflowEngine } from './engine.js';
import { createCoreNodeRegistry } from './nodes/index.js';
import { allowAllSsrfGuard } from './ssrf.js';
import { WorkflowError, type WorkflowDefinition } from './types.js';

/** Recursively replace any `secret` key with [REDACTED]. */
function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = key === 'secret' ? '[REDACTED]' : redactSecrets(entry);
    }
    return out;
  }
  return value;
}

const instantSleep = async () => {};

describe('WorkflowEngine end-to-end', () => {
  let server: Server;
  let baseUrl: string;
  const requestedUrls: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      requestedUrls.push(req.url ?? '');
      const match = /^\/users\/(\d+)$/.exec(req.url ?? '');
      if (match) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: Number(match[1]), name: 'Ada' }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function buildWorkflow(): WorkflowDefinition {
    return {
      id: 'wf-e2e',
      name: 'E2E',
      nodes: [
        {
          id: 'trigger',
          type: 'core.manualTrigger',
          name: 'Start',
          parameters: {
            payload: { userId: 7, first: 'Ada', last: 'Lovelace', secret: 'p@ss' },
          },
        },
        {
          id: 'set',
          type: 'core.setData',
          name: 'Set',
          parameters: {
            assignments: [
              { name: 'fullName', value: '{{ $json.first }} {{ $json.last }}' },
              { name: 'doubleId', value: '{{ $json.userId * 2 }}' },
            ],
          },
        },
        {
          id: 'check',
          type: 'core.if',
          name: 'Check',
          parameters: { left: '{{ $json.userId }}', operator: 'gt', right: 5 },
        },
        {
          id: 'fetch',
          type: 'core.httpRequest',
          name: 'Fetch',
          parameters: { method: 'GET', url: `${baseUrl}/users/{{ $json.userId }}` },
        },
        {
          id: 'after',
          type: 'core.setData',
          name: 'After',
          parameters: {
            assignments: [
              { name: 'fetchedName', value: '{{ $node["Fetch"].json.body.name }}' },
            ],
          },
        },
        { id: 'logFalse', type: 'core.log', name: 'LogFalse', parameters: {} },
      ],
      edges: [
        { from: 'trigger', to: 'set' },
        { from: 'set', to: 'check' },
        { from: 'check', output: 0, to: 'fetch' },
        { from: 'check', output: 1, to: 'logFalse' },
        { from: 'fetch', to: 'after' },
      ],
    };
  }

  it('runs trigger -> setData -> if(true) -> http -> setData($node)', async () => {
    requestedUrls.length = 0;
    const logger = new MemoryNodeLogger();
    const engine = new WorkflowEngine(createCoreNodeRegistry(), {
      ssrfGuard: allowAllSsrfGuard, // test server is on loopback
      redactor: redactSecrets,
      logger,
      sleep: instantSleep,
    });

    const record = await engine.execute(buildWorkflow());
    assert.equal(record.status, 'success');
    assert.equal(record.workflowId, 'wf-e2e');

    const byId = new Map(record.steps.map((s) => [s.nodeId, s]));
    assert.equal(byId.get('trigger')?.status, 'success');
    assert.equal(byId.get('set')?.status, 'success');
    assert.equal(byId.get('check')?.status, 'success');
    assert.equal(byId.get('fetch')?.status, 'success');
    assert.equal(byId.get('after')?.status, 'success');
    // The IF false branch got no items, so its downstream node is skipped.
    assert.equal(byId.get('logFalse')?.status, 'skipped');

    // The HTTP node really called the local server with the rendered URL.
    assert.deepEqual(requestedUrls, ['/users/7']);

    // setData produced typed + interpolated values.
    const setOutput = byId.get('set')?.output as Array<
      Array<{ json: Record<string, unknown> }>
    >;
    assert.equal(setOutput[0]?.[0]?.json.fullName, 'Ada Lovelace');
    assert.equal(setOutput[0]?.[0]?.json.doubleId, 14);

    // $node["Fetch"] resolved in the downstream setData.
    const afterOutput = byId.get('after')?.output as Array<
      Array<{ json: Record<string, unknown> }>
    >;
    assert.equal(afterOutput[0]?.[0]?.json.fetchedName, 'Ada');

    // The record is redacted, but live data was not: the fetch still used 7.
    const triggerOutput = byId.get('trigger')?.output as Array<
      Array<{ json: Record<string, unknown> }>
    >;
    assert.equal(triggerOutput[0]?.[0]?.json.secret, '[REDACTED]');
  });

  it('blocks loopback HTTP under the default SSRF guard', async () => {
    const engine = new WorkflowEngine(createCoreNodeRegistry(), {
      sleep: instantSleep,
    });
    const workflow: WorkflowDefinition = {
      id: 'wf-ssrf',
      nodes: [
        { id: 't', type: 'core.manualTrigger', parameters: { payload: {} } },
        {
          id: 'h',
          type: 'core.httpRequest',
          parameters: { url: `${baseUrl}/users/7` },
        },
      ],
      edges: [{ from: 't', to: 'h' }],
    };
    const record = await engine.execute(workflow);
    assert.equal(record.status, 'error');
    const step = record.steps.find((s) => s.nodeId === 'h');
    assert.equal(step?.status, 'error');
    assert.match(step?.error ?? '', /private IP|Blocked/);
  });
});

describe('WorkflowEngine error handling', () => {
  function registryWithFailing() {
    const registry = createCoreNodeRegistry();
    let calls = 0;
    registry.register(
      defineNode({
        type: 'test.flaky',
        displayName: 'Flaky',
        description: 'Fails a configurable number of times',
        version: 1,
        category: 'Test',
        inputs: {},
        outputs: {},
        async execute(ctx, input) {
          calls += 1;
          const failTimes = Number(ctx.parameters.failTimes ?? Infinity);
          if (calls <= failTimes) throw new Error(`boom ${calls}`);
          return [input];
        },
      }),
    );
    return { registry, calls: () => calls };
  }

  const baseNodes = [
    { id: 't', type: 'core.manualTrigger', parameters: { payload: { ok: true } } },
  ];

  it('onError=stop halts the run and marks it error', async () => {
    const { registry } = registryWithFailing();
    const engine = new WorkflowEngine(registry, { sleep: instantSleep });
    const record = await engine.execute({
      id: 'wf-stop',
      nodes: [
        ...baseNodes,
        { id: 'f', type: 'test.flaky', parameters: {} },
        { id: 'after', type: 'core.noop' },
      ],
      edges: [
        { from: 't', to: 'f' },
        { from: 'f', to: 'after' },
      ],
    });
    assert.equal(record.status, 'error');
    assert.match(record.error ?? '', /boom/);
    assert.equal(
      record.steps.find((s) => s.nodeId === 'after')?.status,
      'skipped',
    );
  });

  it('onError=continue marks the run partial and other branches still run', async () => {
    const { registry } = registryWithFailing();
    const engine = new WorkflowEngine(registry, { sleep: instantSleep });
    const record = await engine.execute({
      id: 'wf-continue',
      nodes: [
        ...baseNodes,
        { id: 'f', type: 'test.flaky', parameters: {}, onError: 'continue' as const },
        { id: 'ok', type: 'core.noop' },
      ],
      edges: [
        { from: 't', to: 'f' },
        { from: 't', to: 'ok' },
      ],
    });
    assert.equal(record.status, 'partial');
    assert.equal(record.steps.find((s) => s.nodeId === 'f')?.status, 'error');
    assert.equal(record.steps.find((s) => s.nodeId === 'ok')?.status, 'success');
  });

  it('retries with backoff until the node succeeds', async () => {
    const { registry, calls } = registryWithFailing();
    const engine = new WorkflowEngine(registry, { sleep: instantSleep });
    const record = await engine.execute({
      id: 'wf-retry',
      nodes: [
        ...baseNodes,
        {
          id: 'f',
          type: 'test.flaky',
          parameters: { failTimes: 2 },
          retry: { maxAttempts: 3, backoffMs: 1 },
        },
      ],
      edges: [{ from: 't', to: 'f' }],
    });
    assert.equal(record.status, 'success');
    assert.equal(calls(), 3);
    const step = record.steps.find((s) => s.nodeId === 'f');
    assert.equal(step?.attempts, 3);
    assert.equal(step?.status, 'success');
  });

  it('gives up after maxAttempts when the node keeps failing', async () => {
    const { registry, calls } = registryWithFailing();
    const engine = new WorkflowEngine(registry, { sleep: instantSleep });
    const record = await engine.execute({
      id: 'wf-retry-fail',
      nodes: [
        ...baseNodes,
        {
          id: 'f',
          type: 'test.flaky',
          parameters: {},
          retry: { maxAttempts: 2, backoffMs: 1 },
        },
      ],
      edges: [{ from: 't', to: 'f' }],
    });
    assert.equal(record.status, 'error');
    assert.equal(calls(), 2);
    assert.equal(record.steps.find((s) => s.nodeId === 'f')?.attempts, 2);
  });
});

describe('WorkflowEngine validation', () => {
  it('rejects unknown node types', async () => {
    const engine = new WorkflowEngine(createCoreNodeRegistry(), {
      sleep: instantSleep,
    });
    await assert.rejects(
      () =>
        engine.execute({
          id: 'wf-bad',
          nodes: [{ id: 'x', type: 'core.doesNotExist' }],
          edges: [],
        }),
      WorkflowError,
    );
  });

  it('rejects cyclic graphs', async () => {
    const engine = new WorkflowEngine(createCoreNodeRegistry(), {
      sleep: instantSleep,
    });
    await assert.rejects(
      () =>
        engine.execute({
          id: 'wf-cycle',
          nodes: [
            { id: 'a', type: 'core.noop' },
            { id: 'b', type: 'core.noop' },
          ],
          edges: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
          ],
        }),
      /cycle/,
    );
  });

  it('runs a webhook-triggered workflow from supplied request data', async () => {
    const engine = new WorkflowEngine(createCoreNodeRegistry(), {
      sleep: instantSleep,
    });
    const record = await engine.execute(
      {
        id: 'wf-webhook',
        nodes: [
          { id: 'hook', type: 'core.webhookTrigger', name: 'Hook', parameters: {} },
          {
            id: 'set',
            type: 'core.setData',
            parameters: {
              assignments: [
                { name: 'orderId', value: '{{ $json.orderId }}' },
              ],
            },
          },
        ],
        edges: [{ from: 'hook', to: 'set' }],
      },
      {
        triggerData: {
          method: 'POST',
          path: '/hooks/order',
          headers: {},
          query: {},
          body: { orderId: 99 },
        },
      },
    );
    assert.equal(record.status, 'success');
    const setOutput = record.steps.find((s) => s.nodeId === 'set')
      ?.output as Array<Array<{ json: Record<string, unknown> }>>;
    assert.equal(setOutput[0]?.[0]?.json.orderId, 99);
  });
});
