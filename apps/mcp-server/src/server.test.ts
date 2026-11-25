/**
 * MCP server tools: in-memory client <-> server round-trips with a stubbed
 * API. No network, no real platform instance.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  McpClient,
  McpRemoteError,
  McpServer,
  createInMemoryTransportPair,
  type CallToolResult,
} from '@code-brothers/mcp-bridge';
import { createPlatformTools, type ApiCaller, type ApiResult } from './tools.js';

const TOOL_NAMES = [
  'codebrothers_health',
  'codebrothers_list_templates',
  'codebrothers_import_template',
  'codebrothers_list_workflows',
  'codebrothers_get_workflow',
  'codebrothers_import_workflow',
  'codebrothers_run_workflow',
  'codebrothers_set_workflow_active',
  'codebrothers_list_runs',
  'codebrothers_list_credentials',
  'codebrothers_ai_chat',
];

function fakeTemplate(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    description: `Test template ${name}`,
    nodes: [{ id: 'n1', type: 'core.manualTrigger', params: {} }],
    edges: [],
    settings: { variables: { ownerPhone: '', apiBaseUrl: 'http://localhost:3000' } },
  };
}

interface Harness {
  client: McpClient;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  close(): Promise<void>;
}

function buildHarness(stub: ApiCaller, templatesDir: string): Harness {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const server = new McpServer({ name: 'code-brothers', version: '0.1.0' });
  const calls: Harness['calls'] = [];
  const recording: ApiCaller = async (method, path, body) => {
    calls.push({ method, path, body });
    return stub(method, path, body);
  };
  for (const tool of createPlatformTools({ callApi: recording, templatesDir })) {
    server.registerTool(tool);
  }
  server.connect(serverTransport);
  const client = new McpClient(clientTransport);
  return { client, calls, close: () => client.close() };
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => c.text).join('');
}

function makeTemplatesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cb-mcp-test-'));
  writeFileSync(
    join(dir, 'template-01-test-one.json'),
    JSON.stringify(fakeTemplate('template-01-test-one', 'Test One')),
  );
  writeFileSync(
    join(dir, 'template-02-test-two.json'),
    JSON.stringify(fakeTemplate('template-02-test-two', 'Test Two')),
  );
  return dir;
}

const ok =
  (body: unknown): ApiResult =>
  ({ status: 200, body });

test('initialize + tools/list exposes the 11 platform tools', async () => {
  const dir = makeTemplatesDir();
  try {
    const { client, close } = buildHarness(async () => ok({}), dir);
    try {
      const init = await client.initialize();
      assert.equal(init.serverInfo.name, 'code-brothers');
      assert.equal(init.serverInfo.version, '0.1.0');
      const tools = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        [...TOOL_NAMES].sort(),
      );
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('health merges setup status and health score', async () => {
  const dir = makeTemplatesDir();
  try {
    const { client, calls, close } = buildHarness(async (method, path) => {
      if (path === '/api/setup/status') return ok({ setupRequired: false });
      if (path === '/api/security/health-score') return ok({ score: 90 });
      throw new Error(`unexpected ${method} ${path}`);
    }, dir);
    try {
      await client.initialize();
      const result = await client.callTool('codebrothers_health', {});
      assert.equal(result.isError, false);
      const data = JSON.parse(textOf(result)) as Record<string, unknown>;
      assert.deepEqual(data, { setup: { setupRequired: false }, health: { score: 90 } });
      assert.deepEqual(
        calls.map((c) => `${c.method} ${c.path}`),
        ['GET /api/setup/status', 'GET /api/security/health-score'],
      );
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list_templates reads the bundled templates directory', async () => {
  const dir = makeTemplatesDir();
  try {
    const { client, close } = buildHarness(async () => ok({}), dir);
    try {
      await client.initialize();
      const result = await client.callTool('codebrothers_list_templates', {});
      assert.equal(result.isError, false);
      const data = JSON.parse(textOf(result)) as {
        templates: Array<{ id: string; variables: string[]; nodeTypes: string[] }>;
      };
      assert.equal(data.templates.length, 2);
      assert.deepEqual(
        data.templates.map((t) => t.id),
        ['template-01-test-one', 'template-02-test-two'],
      );
      assert.deepEqual(data.templates[0]?.variables, ['ownerPhone', 'apiBaseUrl']);
      assert.deepEqual(data.templates[0]?.nodeTypes, ['core.manualTrigger']);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('import_template merges variables and creates the workflow', async () => {
  const dir = makeTemplatesDir();
  try {
    const { client, calls, close } = buildHarness(async (method, path, body) => {
      if (method === 'POST' && path === '/api/workflows') {
        return {
          status: 201,
          body: { id: 'wf-1', name: 'Test One', isActive: false, currentVersion: 1 },
        };
      }
      throw new Error(`unexpected ${method} ${path}`);
    }, dir);
    try {
      await client.initialize();
      const result = await client.callTool('codebrothers_import_template', {
        templateId: 'template-01-test-one',
        variables: { ownerPhone: '923001234567' },
      });
      assert.equal(result.isError, false);
      const data = JSON.parse(textOf(result)) as Record<string, unknown>;
      assert.equal(data.id, 'wf-1');
      assert.equal(calls.length, 1);
      const posted = calls[0]?.body as Record<string, unknown>;
      assert.equal(posted.name, 'Test One');
      assert.deepEqual((posted.settings as Record<string, unknown>).variables, {
        ownerPhone: '923001234567',
        apiBaseUrl: 'http://localhost:3000',
      });
      assert.deepEqual(posted.tags, ['template', 'template-01-test-one']);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('import_template with an unknown id fails as a tool error listing what exists', async () => {
  const dir = makeTemplatesDir();
  try {
    const { client, close } = buildHarness(async () => ok({}), dir);
    try {
      await client.initialize();
      const result = await client.callTool('codebrothers_import_template', {
        templateId: 'template-99-nope',
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /unknown template "template-99-nope"/);
      assert.match(textOf(result), /template-01-test-one/);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run + activate + list_runs hit the exact API routes', async () => {
  const dir = makeTemplatesDir();
  try {
    const { client, calls, close } = buildHarness(async (method, path) => {
      if (path === '/api/workflows/wf-1/run') {
        return { status: 201, body: { id: 'run-1', status: 'success' } };
      }
      if (path === '/api/workflows/wf-1/activate') {
        return ok({ id: 'wf-1', name: 'Test One', isActive: true, currentVersion: 1 });
      }
      if (path.startsWith('/api/executions')) {
        return ok({ executions: [{ id: 'run-1', status: 'success' }] });
      }
      throw new Error(`unexpected ${method} ${path}`);
    }, dir);
    try {
      await client.initialize();
      const run = await client.callTool('codebrothers_run_workflow', {
        id: 'wf-1',
        variables: { name: 'test' },
      });
      assert.equal(run.isError, false);
      assert.equal((JSON.parse(textOf(run)) as Record<string, unknown>).id, 'run-1');
      const act = await client.callTool('codebrothers_set_workflow_active', {
        id: 'wf-1',
        active: true,
      });
      assert.equal(act.isError, false);
      assert.equal((JSON.parse(textOf(act)) as Record<string, unknown>).isActive, true);
      const runs = await client.callTool('codebrothers_list_runs', { workflowId: 'wf-1' });
      assert.equal(runs.isError, false);
      assert.deepEqual(
        calls.map((c) => `${c.method} ${c.path}`),
        [
          'POST /api/workflows/wf-1/run',
          'POST /api/workflows/wf-1/activate',
          'GET /api/executions?limit=20&workflowId=wf-1',
        ],
      );
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an API error comes back as an isError tool result, not a protocol error', async () => {
  const dir = makeTemplatesDir();
  try {
    const { client, close } = buildHarness(async () => ({
      status: 404,
      body: { error: 'workflow_not_found' },
    }), dir);
    try {
      await client.initialize();
      const result = await client.callTool('codebrothers_get_workflow', { id: 'missing' });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /404/);
      assert.match(textOf(result), /workflow_not_found/);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('calling an unknown tool is a protocol error', async () => {
  const dir = makeTemplatesDir();
  try {
    const { client, close } = buildHarness(async () => ok({}), dir);
    try {
      await client.initialize();
      await assert.rejects(client.callTool('codebrothers_nope', {}), McpRemoteError);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
