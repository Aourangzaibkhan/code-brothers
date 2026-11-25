#!/usr/bin/env node
/**
 * Verify gap 6 (worker runtime) live against real Postgres.
 *
 *   1. Boots the real API on PORT 3003 with DATABASE_URL pointing at the
 *      scratch database (default codebrothers_persist) and claims setup.
 *   2. Creates + activates a workflow with a `core.cronTrigger`
 *      (`* * * * *` — every minute) that writes a marker via setData.
 *   3. Starts the real worker (apps/worker/dist/server.js) with the same
 *      DATABASE_URL + CB_MASTER_KEY.
 *   4. Waits for the next minute boundary and proves the scheduled run
 *      appears in the API's GET /api/executions history with status
 *      success and the marker + owner id in its output.
 *   5. Proves the kill switch is shared: POST /api/security/kill-switch
 *      flips the platform_state row the worker reads (checked directly
 *      in Postgres), and resume flips it back.
 *   6. Proves PgPollingStateStore round-trips a cursor in Postgres.
 *
 * Run: node scripts/verify-worker.mjs [--api-port 3003]
 * Env: CB_MASTER_KEY (default: generated), DATABASE_URL (default:
 * postgres://codebrothers:codebrothers@127.0.0.1:5432/codebrothers_persist)
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';

const API_PORT = Number(process.argv.find((a) => a.startsWith('--api-port='))?.split('=')[1] ?? 3003);
const API = `http://127.0.0.1:${API_PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://codebrothers:codebrothers@127.0.0.1:5432/codebrothers_persist';
const WORKFLOW_NAME = 'Worker verify — every minute';
const OWNER_PASSWORD = randomBytes(16).toString('hex');

let checks = 0;
let failures = 0;
function check(name, ok, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

/**
 * Reset the scratch database to a fresh state (all data tables, CASCADE
 * for the FKs). schema_migrations is untouched — migrations stay applied.
 * platform_state keeps its single row, reset to "not halted".
 */
async function resetDb() {
  await pool.query(`TRUNCATE users, sessions, credentials, workflows, workflow_versions,
    webhooks, webhook_replay_nonces, executions, execution_steps, ai_assistants,
    ai_memories, knowledge_documents, embeddings, whatsapp_sessions, sku_mappings,
    customers_crm, payment_tids, security_audit_logs, ip_bans, polling_state,
    products RESTART IDENTITY CASCADE`);
  await pool.query("UPDATE platform_state SET halted = false WHERE id = 'platform'");
  await pool.query(
    "INSERT INTO platform_state (id, halted) VALUES ('platform', false) ON CONFLICT (id) DO NOTHING",
  );
}

async function cleanupWorkflow() {
  await pool.query(
    `DELETE FROM execution_steps WHERE execution_id IN
       (SELECT id FROM executions WHERE workflow_id IN
         (SELECT id FROM workflows WHERE name = $1))`,
    [WORKFLOW_NAME],
  );
  await pool.query(
    'DELETE FROM executions WHERE workflow_id IN (SELECT id FROM workflows WHERE name = $1)',
    [WORKFLOW_NAME],
  );
  await pool.query('DELETE FROM workflows WHERE name = $1', [WORKFLOW_NAME]);
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
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

function spawnProc(cmd, args, extraEnv) {
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  return {
    child,
    getOutput: () => output,
    waitReady: async (url, label) => {
      for (let i = 0; i < 50; i++) {
        try {
          const res = await fetch(url);
          if (res.ok) return;
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`${label} did not come up:\n${output}`);
    },
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }),
  };
}

async function main() {
  await resetDb();
  await cleanupWorkflow();
  const masterKey = process.env.CB_MASTER_KEY ?? randomBytes(32).toString('hex');

  // --- phase 1: API + cron workflow --------------------------------------
  console.log('phase 1: API with Postgres, create + activate cron workflow');
  const apiProc = spawnProc('node', ['apps/api/dist/server.js'], {
    PORT: String(API_PORT),
    HOST: '127.0.0.1',
    CB_MASTER_KEY: masterKey,
    DATABASE_URL,
  });
  let workerProc;
  try {
    await apiProc.waitReady(`${API}/api/setup/status`, 'API');
    const setupToken = apiProc.getOutput().match(/setup token: ([A-Za-z0-9_-]+)/i)?.[1];
    if (!setupToken) throw new Error('no setup token in API output:\n' + apiProc.getOutput());
    const claim = await api('POST', '/api/setup/claim', undefined, {
      setupToken,
      email: 'owner@example.com',
      password: OWNER_PASSWORD,
    });
    check('setup claim succeeds', claim.status === 201, JSON.stringify(claim.body));
    const token = claim.body.token;
    const ownerId = claim.body.user?.id;
    check('owner id returned', typeof ownerId === 'string' && ownerId.length > 0);

    const created = await api('POST', '/api/workflows', token, {
      name: WORKFLOW_NAME,
      nodes: [
        {
          id: 'cron',
          type: 'core.cronTrigger',
          name: 'Every minute',
          parameters: { expression: '* * * * *' },
        },
        {
          id: 'mark',
          type: 'core.setData',
          name: 'Mark',
          parameters: {
            assignments: [
              { name: 'firedBy', value: 'worker-cron-verify' },
              { name: 'ownerId', value: '{{ $vars.userId }}' },
            ],
          },
        },
        { id: 'log', type: 'core.log', name: 'Log', parameters: {} },
      ],
      edges: [
        { from: 'cron', to: 'mark' },
        { from: 'mark', to: 'log' },
      ],
    });
    check('cron workflow created', created.status === 201, JSON.stringify(created.body));
    const workflowId = created.body.id;
    const activated = await api('POST', `/api/workflows/${workflowId}/activate`, token, {});
    check(
      'workflow activated',
      activated.status === 200 && activated.body.isActive === true,
      JSON.stringify(activated.body),
    );

    // --- phase 2: worker --------------------------------------------------
    console.log('phase 2: worker boots and fires the schedule');
    workerProc = spawnProc('node', ['apps/worker/dist/server.js'], {
      DATABASE_URL,
      CB_MASTER_KEY: masterKey,
      CB_WORKER_TICK_MS: '5000',
    });
    // The worker has no HTTP port; readiness = its log line.
    let workerReady = false;
    for (let i = 0; i < 50; i++) {
      if (/cron schedule\(s\) armed/.test(workerProc.getOutput())) {
        workerReady = true;
        break;
      }
      if (workerProc.child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    check('worker boots and arms schedules', workerReady, workerProc.getOutput().slice(-500));
    check(
      'worker armed exactly 1 schedule',
      /1 cron schedule\(s\) armed/.test(workerProc.getOutput()),
      workerProc.getOutput().slice(-500),
    );

    // Wait for the next minute boundary + tick + run (up to 150s).
    let execution;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const list = await api('GET', `/api/executions?workflowId=${workflowId}`, token);
      const found = (list.body.executions ?? []).find((e) => e.status === 'success');
      if (found) {
        execution = found;
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    check('scheduled run appears in API execution history', Boolean(execution));
    if (execution) {
      check('scheduled run triggerType is cron', execution.triggerType === 'cron');
      const detail = await api('GET', `/api/executions/${execution.id}`, token);
      const stepsJson = JSON.stringify(detail.body.steps ?? []);
      check('run output carries the worker marker', stepsJson.includes('worker-cron-verify'));
      check('run output carries the owner id ($vars.userId)', stepsJson.includes(ownerId));
      check(
        'run recorded with workflow version 1',
        detail.body.workflowVersion === 1,
        JSON.stringify(detail.body.workflowVersion),
      );
    }
    check(
      'worker logged the scheduled enqueue',
      /scheduled run enqueued/.test(workerProc.getOutput()),
      workerProc.getOutput().slice(-800),
    );

    // --- phase 3: kill switch is shared ----------------------------------
    console.log('phase 3: kill switch shared between API and worker');
    const halt = await api('POST', '/api/security/kill-switch', token, {});
    check('API kill-switch call succeeds', halt.status === 200 && halt.body.halted === true);
    const haltedRow = await pool.query("SELECT halted FROM platform_state WHERE id = 'platform'");
    check('platform_state row is halted', haltedRow.rows[0]?.halted === true);
    const resume = await api('POST', '/api/security/resume', token, {});
    check('API resume call succeeds', resume.status === 200 && resume.body.halted === false);
    const resumedRow = await pool.query("SELECT halted FROM platform_state WHERE id = 'platform'");
    check('platform_state row is resumed', resumedRow.rows[0]?.halted === false);

    // --- phase 4: polling-state store round-trip --------------------------
    console.log('phase 4: PgPollingStateStore round-trip');
    const { PgPollingStateStore } = await import('./../apps/worker/dist/pg-adapters.js');
    const store = new PgPollingStateStore(pool);
    check('no cursor before first set', (await store.get('daraz:test-seller')) === undefined);
    await store.set('daraz:test-seller', 'cursor-123');
    check('cursor round-trips', (await store.get('daraz:test-seller')) === 'cursor-123');
    await pool.query("DELETE FROM polling_state WHERE source = 'daraz' AND account_ref = 'test-seller'");
    check('cursor deleted after check', (await store.get('daraz:test-seller')) === undefined);
  } finally {
    if (workerProc) await workerProc.stop();
    await apiProc.stop();
    await cleanupWorkflow();
    await pool.end();
  }

  console.log(`\nWORKER: ${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    console.log('WORKER VERIFICATION FAILED');
    process.exitCode = 1;
  } else {
    console.log('WORKER VERIFIED: scheduled triggers fire and land in the API history.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
