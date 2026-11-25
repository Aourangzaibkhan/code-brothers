/**
 * MCP-server verification: the buyer-deliverable proof.
 *
 * Boots the real API (in-memory stores, scratch port), claims the owner
 * account, then drives the MCP server over stdio exactly as a buyer's agent
 * would: initialize -> tools/list -> health -> list/import templates ->
 * import a workflow -> run it -> verify the execution -> activate it.
 *
 * No real provider accounts or keys are used anywhere: the template is only
 * imported (never run against a live provider) and the manual workflow uses
 * core nodes only. The AI chat check asserts the honest 503
 * (no_ai_provider_configured) when no provider is configured.
 *
 * Usage:
 *   npm run build
 *   node scripts/verify-mcp-server.mjs [--api-port 3003]
 *
 * Exit code 0 = every check passed.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = Number(
  process.argv.find((a) => a.startsWith('--api-port='))?.split('=')[1] ?? 3003,
);
const API = `http://127.0.0.1:${API_PORT}`;

const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(name);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function spawnApi(masterKey) {
  const child = spawn('node', ['apps/api/dist/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      CB_MASTER_KEY: masterKey,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stdout += d.toString()));
  return { child, getOutput: () => stdout };
}

async function waitForApi() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await api('GET', '/api/setup/status');
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`API did not come up on ${API}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await sleep(500);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  const { McpClient, StdioTransport } = await import(
    '../packages/mcp-bridge/dist/index.js'
  );

  const masterKey = randomBytes(32).toString('hex');
  const { child: apiChild, getOutput } = spawnApi(masterKey);
  let client;
  try {
    await waitForApi();
    const out = getOutput();
    const tokenMatch = out.match(/setup token:\s*([A-Za-z0-9_-]+)/i);
    if (!tokenMatch) throw new Error('setup token not found in API output:\n' + out.slice(-2000));
    const testPassword = randomBytes(16).toString('hex');
    const claim = await api('POST', '/api/setup/claim', undefined, {
      setupToken: tokenMatch[1],
      email: 'owner@example.com',
      password: testPassword,
      displayName: 'Owner',
    });
    if (claim.status !== 201 && claim.status !== 200) {
      throw new Error('setup claim failed: ' + JSON.stringify(claim));
    }
    const token = claim.body.token;
    if (!token) throw new Error('claim returned no token: ' + JSON.stringify(claim.body));

    // The MCP server, exactly as a buyer's agent would launch it.
    let mcpStderr = '';
    const transport = new StdioTransport({
      command: 'node',
      args: [join(ROOT, 'apps/mcp-server/dist/server.js')],
      cwd: ROOT,
      env: {
        CB_API_URL: API,
        CB_API_TOKEN: token,
        CB_TEMPLATES_DIR: join(ROOT, 'templates'),
      },
    });
    transport.stderr.on('data', (d) => (mcpStderr += d.toString()));
    client = new McpClient(transport);

    const init = await client.initialize();
    check('mcp initialize', init.serverInfo?.name === 'code-brothers', init.serverInfo?.name);

    const tools = await client.listTools();
    check('mcp tools/list has 11 tools', tools.length === 11, `${tools.length} tools`);

    const health = await client.callTool('codebrothers_health', {});
    check('health tool succeeds', health.isError === false);
    const healthData = JSON.parse(health.content[0].text);
    check(
      'health reports setup complete',
      healthData.setup?.setupRequired === false,
      JSON.stringify(healthData.setup),
    );

    const templates = await client.callTool('codebrothers_list_templates', {});
    check('list_templates succeeds', templates.isError === false);
    const templateData = JSON.parse(templates.content[0].text);
    check(
      'list_templates returns all 10 templates',
      templateData.templates?.length === 10,
      `${templateData.templates?.length ?? 0} templates`,
    );

    const imported = await client.callTool('codebrothers_import_template', {
      templateId: 'template-01-whatsapp-sales-assistant',
      variables: { ownerPhone: '923001234567' },
    });
    check('import_template succeeds', imported.isError === false, imported.content[0].text.slice(0, 200));
    const importedWf = JSON.parse(imported.content[0].text);
    check('import_template returns a workflow id', typeof importedWf.id === 'string', importedWf.id);

    const fetched = await client.callTool('codebrothers_get_workflow', { id: importedWf.id });
    check('get_workflow returns the imported template', fetched.isError === false);
    const fetchedWf = JSON.parse(fetched.content[0].text);
    check(
      'imported template variables were merged',
      fetchedWf.settings?.variables?.ownerPhone === '923001234567',
      JSON.stringify(fetchedWf.settings?.variables),
    );
    check(
      'imported template starts inactive',
      fetchedWf.isActive === false,
      `isActive=${fetchedWf.isActive}`,
    );

    const listed = await client.callTool('codebrothers_list_workflows', {});
    const workflows = JSON.parse(listed.content[0].text).workflows ?? [];
    check(
      'list_workflows contains the imported template',
      workflows.some((w) => w.id === importedWf.id),
      `${workflows.length} workflows`,
    );

    const manual = await client.callTool('codebrothers_import_workflow', {
      name: 'mcp-probe',
      description: 'MCP server verification workflow',
      nodes: [
        { id: 't', type: 'core.manualTrigger', name: 'T', parameters: {} },
        {
          id: 's',
          type: 'core.setData',
          name: 'S',
          parameters: { assignments: [{ name: 'greeting', value: 'hello {{ $vars.userId }}' }] },
        },
      ],
      edges: [{ from: 't', to: 's' }],
      settings: {},
      tags: ['mcp-probe'],
    });
    check('import_workflow succeeds', manual.isError === false, manual.content[0].text.slice(0, 200));
    const manualWf = JSON.parse(manual.content[0].text);
    check('import_workflow returns a workflow id', typeof manualWf.id === 'string', manualWf.id);

    const run = await client.callTool('codebrothers_run_workflow', {
      id: manualWf.id,
      triggerData: {},
      variables: { userId: 'mcp-buyer' },
    });
    check('run_workflow succeeds', run.isError === false, run.content[0].text.slice(0, 200));
    const execution = JSON.parse(run.content[0].text);
    check('manual run status is success', execution.status === 'success', execution.status);

    const runs = await client.callTool('codebrothers_list_runs', { workflowId: manualWf.id });
    const executions = JSON.parse(runs.content[0].text).executions ?? [];
    check(
      'list_runs shows the execution',
      executions.some((e) => e.id === execution.id && e.status === 'success'),
      `${executions.length} executions`,
    );

    const activated = await client.callTool('codebrothers_set_workflow_active', {
      id: manualWf.id,
      active: true,
    });
    check('set_workflow_active succeeds', activated.isError === false);
    check(
      'workflow is active after activation',
      JSON.parse(activated.content[0].text).isActive === true,
    );

    const creds = await client.callTool('codebrothers_list_credentials', {});
    check('list_credentials succeeds', creds.isError === false);
    const credData = JSON.parse(creds.content[0].text);
    check(
      'list_credentials returns metadata only (no secret values)',
      Array.isArray(credData.items) && !JSON.stringify(credData).match(/sk-probe|EAATOKEN|shpat-/),
      `${credData.items?.length ?? 0} credentials`,
    );

    const chat = await client.callTool('codebrothers_ai_chat', { message: 'hello' });
    check(
      'ai_chat honestly reports no provider configured (503)',
      chat.isError === true && chat.content[0].text.includes('no_ai_provider_configured'),
      chat.content[0].text.slice(0, 120),
    );

    if (mcpStderr.trim() !== '') {
      console.log(`--- MCP server stderr ---\n${mcpStderr.trim()}`);
    }
  } finally {
    if (client) await client.close().catch(() => {});
    await stop(apiChild);
  }

  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.length} check(s): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll MCP server checks passed.');
}

main().catch((err) => {
  console.error('verify-mcp-server crashed:', err);
  process.exit(1);
});
