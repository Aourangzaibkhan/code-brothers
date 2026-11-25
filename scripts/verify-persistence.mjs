/**
 * Persistence verification (gap 3).
 *
 * Proves the API survives a restart when DATABASE_URL is set: the owner
 * account, a stored credential (decryptable after restart), a workflow and
 * its run history must all still be there after the process is killed and
 * started again.
 *
 * Usage:
 *   node scripts/verify-persistence.mjs [postgres://user:pass@host:5432/db]
 *
 * The database must exist and be empty-ish (migrations run on boot; the
 * script uses its own owner email so re-runs against the same DB fail
 * honestly at the setup-claim step instead of silently passing).
 *
 * Exit code 0 = everything survived the restart.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL =
  process.argv[2] ??
  process.env.CB_VERIFY_PG ??
  'postgres://codebrothers:codebrothers@127.0.0.1:5432/codebrothers_persist';
const PORT = 3002;
const API = `http://127.0.0.1:${PORT}`;
const MASTER_KEY = randomBytes(32).toString('hex');
// Never hardcode a password literal, even a dummy one — gitleaks flags it
// and the Security check goes red. Generated fresh on every run.
const PASSWORD = randomBytes(16).toString('hex');

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function spawnApi() {
  const child = spawn('node', ['apps/api/dist/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      CB_MASTER_KEY: MASTER_KEY,
      DATABASE_URL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  return { child, getOutput: () => output };
}

async function waitForApi() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await api('GET', '/api/setup/status');
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('API did not come up on ' + API);
}

async function stop(child) {
  child.kill('SIGTERM');
  await sleep(1500);
  if (!child.killed) child.kill('SIGKILL');
  await sleep(500);
}

async function main() {
  // ---- Boot 1: claim, seed, run -----------------------------------------
  let first = spawnApi();
  let token;
  let workflowId;
  let executionId;
  let hmacSecret;
  try {
    await waitForApi();
    const out = first.getOutput();
    const m = out.match(/setup token:\s*([A-Za-z0-9_-]+)/i);
    if (!m) throw new Error('no setup token in API output:\n' + out.slice(-2000));
    const claim = await api('POST', '/api/setup/claim', undefined, {
      setupToken: m[1],
      email: 'persist-owner@example.com',
      password: PASSWORD,
      displayName: 'Persist Owner',
    });
    check('boot1 setup claim', claim.status === 201, `status ${claim.status}`);
    token = claim.body.token;

    // A credential whose decryption after restart proves the vault round-trips
    // through the Pg bytea columns (incl. the 0015 wrap-tag column).
    const cred = await api('POST', '/api/credentials', token, {
      name: 'probe',
      value: { apiKey: 'sk-probe-123', note: 'persistence probe' },
    });
    check('boot1 credential stored', cred.status === 201, `status ${cred.status}`);

    const wf = await api('POST', '/api/workflows', token, {
      name: 'persistence-probe',
      description: 'gap 3 probe',
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
    });
    check('boot1 workflow created', wf.status === 201, `status ${wf.status}`);
    workflowId = wf.body.id;

    const run = await api('POST', `/api/workflows/${workflowId}/run`, token, { triggerData: {} });
    check('boot1 workflow run success', run.status === 201 && run.body.status === 'success', `status ${run.status}`);
    executionId = run.body.id;

    // A RAG document: must survive the restart too (knowledge_documents).
    const ragDoc = await api('POST', '/api/rag/documents', token, {
      title: 'Red Shoes',
      content: 'Red Shoes are our best-selling running shoes. Price 2500, 10 in stock.',
      metadata: { price: 2500, stock: 10, sku: 'red shoes' },
    });
    check('boot1 RAG document stored', ragDoc.status === 200, `status ${ragDoc.status}`);

    // A webhook whose HMAC secret is envelope-encrypted into Pg: calling it
    // after the restart proves the secret still decrypts (the gateway
    // returns 500 webhook_secret_unavailable when it does not).
    const hook = await api('POST', '/api/webhooks', token, { workflowId, slug: 'persist-probe' });
    check('boot1 webhook created', hook.status === 201, `status ${hook.status}`);
    hmacSecret = hook.body.hmacSecret;
  } finally {
    await stop(first.child);
  }

  // ---- Boot 2: everything must still be there ---------------------------
  let second = spawnApi();
  try {
    await waitForApi();
    const status = await api('GET', '/api/setup/status');
    check('boot2 setup already claimed', status.body.setupRequired === false, JSON.stringify(status.body));

    const login = await api('POST', '/api/auth/login', undefined, {
      email: 'persist-owner@example.com',
      password: PASSWORD,
    });
    check('boot2 owner login works', login.status === 200 && Boolean(login.body.token), `status ${login.status}`);
    token = login.body.token;

    const workflows = await api('GET', '/api/workflows', token);
    const found = (workflows.body.workflows ?? []).some((w) => w.id === workflowId);
    check('boot2 workflow survived restart', found, `listed ${(workflows.body.workflows ?? []).length} workflows`);

    const execution = await api('GET', `/api/executions/${executionId}`, token);
    check(
      'boot2 execution history survived restart',
      execution.status === 200 && execution.body.status === 'success',
      `status ${execution.status}`,
    );

    // Decryption proof: call the boot-1 webhook with a valid HMAC signature.
    // The gateway must decrypt the stored HMAC secret to verify it — a
    // broken vault round-trip (e.g. a missing wrap-tag column) fails here.
    const { createHmac } = await import('node:crypto');
    const raw = JSON.stringify({ probe: 'after-restart' });
    const signature = createHmac('sha256', hmacSecret).update(raw).digest('hex');
    const hookRes = await fetch(`${API}/hooks/persist-probe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code-brothers-signature': signature,
        'x-code-brothers-nonce': 'persist-nonce-1',
      },
      body: raw,
    });
    const hookBody = await hookRes.text();
    check(
      'boot2 webhook HMAC secret still decrypts (202 + success)',
      hookRes.status === 202 && JSON.parse(hookBody).status === 'success',
      `status ${hookRes.status} ${hookBody.slice(0, 160)}`,
    );

    // Replay proof: the same nonce after the restart must still be rejected
    // (the nonce cache is Pg-backed now, not memory).
    const replayRes = await fetch(`${API}/hooks/persist-probe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code-brothers-signature': signature,
        'x-code-brothers-nonce': 'persist-nonce-1',
      },
      body: raw,
    });
    check('boot2 replay nonce still rejected after restart', replayRes.status === 409, `status ${replayRes.status}`);

    const creds = await api('GET', '/api/credentials', token);
    check(
      'boot2 credential metadata survived restart',
      creds.status === 200 && (creds.body.items ?? []).some((c) => c.name === 'probe'),
      `status ${creds.status}`,
    );

    const audit = await api('GET', '/api/security/audit-logs?limit=5', token);
    check('boot2 audit log readable', audit.status === 200 && Array.isArray(audit.body.logs), `status ${audit.status}`);

    const ragDocs = await api('GET', '/api/rag/documents', token);
    check(
      'boot2 RAG document survived restart',
      ragDocs.status === 200 &&
        (ragDocs.body.documents ?? []).some((d) => d.title === 'Red Shoes'),
      `status ${ragDocs.status}`,
    );
    const ragSearch = await api('POST', '/api/rag/search', token, { query: 'red shoes', limit: 3 });
    check(
      'boot2 RAG search finds the persisted document',
      ragSearch.status === 200 &&
        (ragSearch.body.results ?? []).some((r) => r.source === 'document' && r.title === 'Red Shoes'),
      `status ${ragSearch.status}`,
    );
  } finally {
    await stop(second.child);
  }

  console.log('');
  if (failures.length === 0) {
    console.log('PERSISTENCE VERIFIED: owner, credential, workflow and run history survived a restart.');
  } else {
    console.log(`${failures.length} check(s) FAILED: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
