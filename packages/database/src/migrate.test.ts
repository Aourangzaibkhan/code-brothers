/**
 * Tests for the migration runner and the §9 schema, executed against
 * pg-mem (an in-memory PostgreSQL double) — no live database required.
 *
 * pg-mem adaptations (test harness only; the migrations themselves are
 * plain PostgreSQL):
 *  - pg-mem does not implement gen_random_uuid(), so it is registered
 *    here backed by node:crypto. Real PostgreSQL 13+ has it built in.
 *    `impure: true` matters: pg-mem otherwise caches the result per
 *    statement and every row would get the same "random" uuid.
 *  - The pgvector migration (0008) is excluded because pg-mem has no
 *    pgvector extension — exactly what the runner's `exclude` option is for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newDb, DataType } from 'pg-mem';
import type { Pool } from 'pg';
import { runMigrations, listApplied } from './migrate.js';

const VECTOR_MIGRATION = '0008_embeddings_vector.sql';

const BASE_MIGRATIONS = [
  '0001_users_sessions.sql',
  '0002_credentials.sql',
  '0003_workflows.sql',
  '0004_webhooks.sql',
  '0005_executions.sql',
  '0006_ai_assistants.sql',
  '0007_knowledge.sql',
  '0009_whatsapp_sessions.sql',
  '0010_sku_mappings.sql',
  '0011_customers_payments.sql',
  '0012_security.sql',
  '0013_polling_state.sql',
];

/** Every table from spec §9, plus the replay-nonce cache and the bookkeeping table. */
const EXPECTED_TABLES = [
  'users',
  'sessions',
  'credentials',
  'workflows',
  'workflow_versions',
  'webhooks',
  'webhook_replay_nonces',
  'executions',
  'execution_steps',
  'ai_assistants',
  'ai_memories',
  'knowledge_documents',
  'embeddings',
  'whatsapp_sessions',
  'sku_mappings',
  'customers_crm',
  'payment_tids',
  'security_audit_logs',
  'ip_bans',
  'polling_state',
  'schema_migrations',
];

function makePool(): Pool {
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  const { Pool: MemPool } = db.adapters.createPg();
  return new MemPool() as unknown as Pool;
}

async function makeMigratedPool(): Promise<Pool> {
  const pool = makePool();
  await runMigrations(pool, { exclude: [VECTOR_MIGRATION] });
  return pool;
}

test('applies all base migrations and creates every spec §9 table', async () => {
  const pool = makePool();
  try {
    const applied = await runMigrations(pool, { exclude: [VECTOR_MIGRATION] });
    assert.deepEqual(applied, BASE_MIGRATIONS);

    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = new Set(
      result.rows.map((row: { table_name: string }) => row.table_name),
    );
    for (const expected of EXPECTED_TABLES) {
      assert.ok(tables.has(expected), `missing table: ${expected}`);
    }
  } finally {
    await pool.end();
  }
});

test('listApplied reports exactly the base migrations (vector migration excluded, not recorded)', async () => {
  const pool = await makeMigratedPool();
  try {
    const applied = await listApplied(pool);
    assert.deepEqual([...applied].sort(), [...BASE_MIGRATIONS].sort());
    assert.ok(!applied.includes(VECTOR_MIGRATION));
  } finally {
    await pool.end();
  }
});

test('is idempotent: a second run applies nothing', async () => {
  const pool = await makeMigratedPool();
  try {
    const second = await runMigrations(pool, { exclude: [VECTOR_MIGRATION] });
    assert.deepEqual(second, []);
    const applied = await listApplied(pool);
    assert.equal(applied.length, BASE_MIGRATIONS.length);
  } finally {
    await pool.end();
  }
});

test('listApplied returns [] on a fresh database', async () => {
  const pool = makePool();
  try {
    assert.deepEqual(await listApplied(pool), []);
  } finally {
    await pool.end();
  }
});

test('insert/select round-trip on users, workflows and payment_tids', async () => {
  const pool = await makeMigratedPool();
  try {
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, role, locale)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, email, role, locale`,
      ['merchant@example.com', '$argon2id$v=19$fakehash', 'Test Merchant', 'owner', 'ur'],
    );
    const user = userResult.rows[0];
    assert.ok(user.id, 'user id generated');
    assert.equal(user.email, 'merchant@example.com');
    assert.equal(user.role, 'owner');
    assert.equal(user.locale, 'ur');

    const nodes = [{ id: 'n1', type: 'webhook' }, { id: 'n2', type: 'http' }];
    const edges = [{ id: 'e1', source: 'n1', target: 'n2' }];
    const workflowResult = await pool.query(
      `INSERT INTO workflows (user_id, name, nodes, edges, settings, is_active)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, true)
       RETURNING id, name, nodes, edges, is_active`,
      [user.id, 'Order notifier', JSON.stringify(nodes), JSON.stringify(edges), JSON.stringify({ retries: 2 })],
    );
    const workflow = workflowResult.rows[0];
    assert.equal(workflow.name, 'Order notifier');
    assert.deepEqual(workflow.nodes, nodes);
    assert.deepEqual(workflow.edges, edges);
    assert.equal(workflow.is_active, true);

    const versionResult = await pool.query(
      `INSERT INTO workflow_versions (workflow_id, version, nodes, edges, created_by)
       VALUES ($1, 1, $2::jsonb, $3::jsonb, $4) RETURNING version`,
      [workflow.id, JSON.stringify(nodes), JSON.stringify(edges), user.id],
    );
    assert.equal(versionResult.rows[0].version, 1);

    const sessionResult = await pool.query(
      `INSERT INTO sessions (user_id, token_hash, device_name, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '7 days') RETURNING user_id, device_name`,
      [user.id, 'hash-of-token', 'Chrome on Windows', '127.0.0.1'],
    );
    assert.equal(sessionResult.rows[0].user_id, user.id);

    const tidResult = await pool.query(
      `INSERT INTO payment_tids (user_id, tid, provider, amount, currency, order_ref)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING tid, provider, amount`,
      [user.id, 'JC-99887766', 'jazzcash', 2500.0, 'PKR', 'ORD-1001'],
    );
    assert.equal(tidResult.rows[0].tid, 'JC-99887766');
    assert.equal(tidResult.rows[0].provider, 'jazzcash');
    assert.equal(Number(tidResult.rows[0].amount), 2500);
  } finally {
    await pool.end();
  }
});

test('duplicate payment TID is rejected by the unique constraint (duplicate-payment shield)', async () => {
  const pool = await makeMigratedPool();
  try {
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ('dup@example.com', 'x') RETURNING id`,
    );
    const userId = userResult.rows[0].id;
    await pool.query(
      `INSERT INTO payment_tids (user_id, tid, provider, amount) VALUES ($1, 'TID-DUP-1', 'easypaisa', 100)`,
      [userId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO payment_tids (user_id, tid, provider, amount) VALUES ($1, 'TID-DUP-1', 'easypaisa', 100)`,
        [userId],
      ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, '23505');
        return true;
      },
    );
  } finally {
    await pool.end();
  }
});

test('SKU pair uniqueness: the same channel SKU cannot map twice for one merchant', async () => {
  const pool = await makeMigratedPool();
  try {
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ('sku@example.com', 'x') RETURNING id`,
    );
    const userId = userResult.rows[0].id;
    await pool.query(
      `INSERT INTO sku_mappings (user_id, master_sku, shopify_sku) VALUES ($1, 'MASTER-1', 'SHOP-1')`,
      [userId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO sku_mappings (user_id, master_sku, shopify_sku) VALUES ($1, 'MASTER-2', 'SHOP-1')`,
        [userId],
      ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, '23505');
        return true;
      },
    );
    // Unmapped (NULL) channel SKUs must not collide with each other.
    await pool.query(
      `INSERT INTO sku_mappings (user_id, master_sku) VALUES ($1, 'MASTER-3')`,
      [userId],
    );
    await pool.query(
      `INSERT INTO sku_mappings (user_id, master_sku) VALUES ($1, 'MASTER-4')`,
      [userId],
    );
  } finally {
    await pool.end();
  }
});

test('foreign keys are enforced (session for a missing user is rejected)', async () => {
  const pool = await makeMigratedPool();
  try {
    await assert.rejects(
      pool.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, 'orphan', now() + interval '1 day')`,
        [randomUUID()],
      ),
    );
  } finally {
    await pool.end();
  }
});
