/**
 * Worker server entrypoint (gap 6).
 *
 * The worker is a separate process from the API: it loads the ACTIVE
 * workflows from Postgres, arms their `core.cronTrigger` schedules, and
 * executes due runs through the same platform engine (all connector
 * nodes registered) with vault-backed credentials per owner. Finished
 * executions are recorded into the same `executions` table the API
 * serves at GET /api/executions, so scheduled runs show up in the
 * dashboard's run history.
 *
 * Required env (the worker refuses to start without them — without
 * Postgres it cannot see the API's workflows, and without the master
 * key it cannot decrypt credentials):
 *   DATABASE_URL    Postgres the API uses (same value as the api service)
 *   CB_MASTER_KEY   64-hex vault master key (same value as the api service)
 * Optional:
 *   CB_INTERNAL_HOSTS   comma-separated SSRF allowlist (default:
 *                         localhost,ai-media-worker,host.docker.internal)
 *   CB_WORKER_TICK_MS   scheduler tick interval (default 30000)
 *
 * Polling triggers (Daraz / YouTube, spec §9) persist their cursors in
 * `polling_state` through PgPollingStateStore — no polling trigger node
 * type ships yet, so no poller is armed here; the store is exported
 * from the worker package for the trigger that needs it.
 */
import { createPool, runMigrations } from '@code-brothers/database';
import { parseMasterKey } from '@code-brothers/security';
import { Scheduler } from './scheduler.js';
import { startWorker } from './worker.js';
import {
  PgExecutionSink,
  PgPlatformHalt,
  PgPollingStateStore,
  PgWorkflowProvider,
  createPgCredentialsProvider,
} from './pg-adapters.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    'worker: DATABASE_URL is required — without Postgres the worker cannot see the API’s workflows. ' +
      'Set it to the same value as the api service (see docker/docker-compose.lite.yml).',
  );
  process.exit(1);
}
const rawMasterKey = process.env.CB_MASTER_KEY;
if (!rawMasterKey) {
  console.error(
    'worker: CB_MASTER_KEY is required — without it the worker cannot decrypt the vault credentials ' +
      'workflows need. Set it to the same value as the api service.',
  );
  process.exit(1);
}
let masterKey: Buffer;
try {
  masterKey = parseMasterKey(rawMasterKey);
} catch (err) {
  console.error(`worker: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const pool = createPool(DATABASE_URL);

// Apply migrations, tolerating a database without the pgvector extension
// (same rule as the API: 0008 is vector-only, the rest of the schema
// works without it).
let applied: string[];
try {
  applied = await runMigrations(pool);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/vector|extension/i.test(message)) {
    applied = await runMigrations(pool, { exclude: ['0008_embeddings_vector.sql'] });
  } else {
    throw err;
  }
}
if (applied.length > 0) console.info({ applied }, 'worker: database migrations applied');

const workflows = new PgWorkflowProvider(pool);
const executions = new PgExecutionSink(pool);
const pollingState = new PgPollingStateStore(pool);
const platformHalt = new PgPlatformHalt(pool);

const { worker } = startWorker({
  workflows,
  executions,
  credentialsProviderFor: (userId: string) =>
    createPgCredentialsProvider(pool, masterKey, userId),
  isHalted: () => platformHalt.isHalted(),
});

// Arm every active workflow's cronTrigger nodes; each due slot enqueues
// a run job (triggerType 'cron', triggerNodeId set so the run starts at
// the cron node, not at the first trigger node).
const scheduler = new Scheduler({
  onFire: async (event) => {
    await worker.enqueueRun({
      workflowId: event.workflow.id,
      triggerType: 'cron',
      triggerNodeId: event.node.id,
      triggerData: {
        scheduledFor: event.scheduledFor.toISOString(),
        expression: event.expression,
      },
    });
    console.info(
      `worker: scheduled run enqueued for workflow ${event.workflow.id} ` +
        `(slot ${event.scheduledFor.toISOString()}, ${event.expression})`,
    );
  },
});

const active = await workflows.listActive();
let armed = 0;
for (const loaded of active) armed += scheduler.register(loaded.definition);
console.info(`worker: ${active.length} active workflow(s), ${armed} cron schedule(s) armed`);
console.info('worker: polling state store ready (Pg polling_state)');

// Workflows can be created/activated/deactivated in the dashboard AFTER
// the worker boots — re-scan Postgres on an interval and arm new
// schedules (registering an already-armed entry is a no-op for us:
// Scheduler.register would reset its next run, so only missing entries
// are registered) and disarm schedules whose workflow went inactive.
async function refreshSchedules(): Promise<void> {
  try {
    const current = await workflows.listActive();
    const activeIds = new Set(current.map((w) => w.definition.id));
    const armedEntries = scheduler.list();
    for (const entry of armedEntries) {
      if (!activeIds.has(entry.workflowId)) {
        scheduler.unregister(entry.workflowId);
        console.info(`worker: disarmed schedule for inactive workflow ${entry.workflowId}`);
      }
    }
    const armedKeys = new Set(armedEntries.map((e) => `${e.workflowId}:${e.nodeId}`));
    for (const loaded of current) {
      const missing = loaded.definition.nodes.some(
        (node) =>
          node.type === 'core.cronTrigger' &&
          !node.disabled &&
          !armedKeys.has(`${loaded.definition.id}:${node.id}`),
      );
      if (!missing) continue;
      const n = scheduler.registerIfMissing(loaded.definition);
      if (n > 0) console.info(`worker: armed ${n} new schedule(s) for workflow ${loaded.definition.id}`);
    }
  } catch (err) {
    console.error('worker: schedule refresh failed:', err instanceof Error ? err.message : err);
  }
}
const refreshTimer = setInterval(() => {
  void refreshSchedules();
}, Number(process.env.CB_WORKER_REFRESH_MS ?? 5 * 60_000));
// Deliberately NOT unref'd: the refresh timer is one of the handles that
// keeps this process alive (see Scheduler.start's keepAlive note).

scheduler.start(Number(process.env.CB_WORKER_TICK_MS ?? 30_000), true);
console.info('worker: running (scheduler ticking, queue processing)');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`worker: ${signal} received, shutting down…`);
  scheduler.stop();
  clearInterval(refreshTimer);
  await worker.waitForIdle();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
