import assert from 'node:assert/strict';
import test from 'node:test';
import {
  McpClient,
  McpRemoteError,
  McpServer,
  StdioTransport,
  createInMemoryTransportPair,
} from './index.js';

function buildServer(serverTransport: Parameters<McpServer['connect']>[0]): McpServer {
  const server = new McpServer({ name: 'test-tools', version: '1.2.3' });
  server.registerTool({
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    run: (args) => Number(args.a) + Number(args.b),
  });
  server.registerTool({
    name: 'echo',
    description: 'Echo text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    run: (args) => String(args.text ?? ''),
  });
  server.registerTool({
    name: 'explode',
    description: 'Always fails',
    inputSchema: { type: 'object' },
    run: () => {
      throw new Error('kaboom');
    },
  });
  server.connect(serverTransport);
  return server;
}

test('client <-> server round-trip over the in-memory transport', async () => {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  buildServer(serverTransport);
  const client = new McpClient(clientTransport);

  const init = await client.initialize();
  assert.equal(init.serverInfo.name, 'test-tools');
  assert.equal(init.serverInfo.version, '1.2.3');
  assert.equal(init.protocolVersion, '2024-11-05');
  assert.equal(client.getServerInfo()?.serverInfo.name, 'test-tools');

  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ['add', 'echo', 'explode'],
  );
  assert.equal(tools[0]?.description, 'Add two numbers');
  assert.equal((tools[0]?.inputSchema as { type?: string }).type, 'object');

  const sum = await client.callTool('add', { a: 2, b: 3 });
  assert.equal(sum.isError, false);
  assert.equal(sum.content[0]?.text, '5');

  const echo = await client.callTool('echo', { text: 'salaam' });
  assert.equal(echo.content[0]?.text, 'salaam');

  await client.close();
});

test('tool failures return isError results; unknown tools are protocol errors', async () => {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  buildServer(serverTransport);
  const client = new McpClient(clientTransport);
  await client.initialize();

  const failed = await client.callTool('explode');
  assert.equal(failed.isError, true);
  assert.match(failed.content[0]?.text ?? '', /kaboom/);

  await assert.rejects(client.callTool('does_not_exist'), (err: unknown) => {
    assert.ok(err instanceof McpRemoteError);
    assert.equal(err.code, -32602);
    return true;
  });

  await client.close();
});

test('stdio transport round-trips initialize with a real child process', async () => {
  // A minimal newline-JSON MCP-ish server written in plain Node.
  const script = `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} },
                    serverInfo: { name: 'stdio-child', version: '0.0.1' } }
        }) + '\\n');
      } else if (msg.method === 'tools/list') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id, result: { tools: [] }
        }) + '\\n');
      }
    });
  `;
  const transport = new StdioTransport({
    command: process.execPath,
    args: ['-e', script],
  });
  const client = new McpClient(transport);
  const init = await client.initialize();
  assert.equal(init.serverInfo.name, 'stdio-child');
  const tools = await client.listTools();
  assert.deepEqual(tools, []);
  await client.close();
});
