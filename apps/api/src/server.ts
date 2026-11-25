/**
 * API server entrypoint.
 *
 * - When DATABASE_URL is set, the PostgreSQL migrations owned by
 *   @code-brothers/database are applied (tolerating a database without the
 *   pgvector extension) and the API runs on the Pg-backed repositories in
 *   ./pg-stores.ts — the owner account, workflows, credentials, webhooks,
 *   audit log and run history all survive a restart.
 * - When DATABASE_URL is unset the API runs on the in-memory stores with a
 *   loud warning: nothing survives a restart there (local dev / tests only).
 * - On first boot (no owner yet) the one-time setup token is printed to
 *   the console exactly once — claim the owner account with it at
 *   POST /api/setup/claim.
 */
import { buildApp } from './app.js';
import type { Pool } from '@code-brothers/database';

let stores: Awaited<ReturnType<typeof buildApp>>['stores'] | undefined;
let pool: Pool | undefined;

if (process.env.DATABASE_URL) {
  const { createPool } = await import('@code-brothers/database');
  const { createPgStores, runMigrationsTolerant } = await import('./pg-stores.js');
  pool = createPool(process.env.DATABASE_URL);
  const applied = await runMigrationsTolerant(pool);
  if (applied.length > 0) {
    console.info({ applied }, 'database migrations applied');
  }
  stores = createPgStores(pool);
}

const built = await buildApp({
  logger: true,
  ...(stores ? { stores } : {}),
  ...(pool ? { ragPool: pool } : {}),
});

if (!stores) {
  built.app.log.warn(
    'DATABASE_URL is not set — running on in-memory stores. The owner account, ' +
      'workflows and run history will be LOST on restart. Set DATABASE_URL to ' +
      'persist (see docker/docker-compose.lite.yml).',
  );
}

if (built.setupToken) {
  built.app.log.warn(
    'First-boot setup is open. Claim the owner account with this one-time setup token: %s',
    built.setupToken,
  );
  if (!built.masterKeyConfigured) {
    built.app.log.warn(
      'CB_MASTER_KEY is not set — an ephemeral vault key was generated. ' +
        'Credentials encrypted in this run cannot be decrypted after a restart.',
    );
  }
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const shutdown = async (): Promise<void> => {
  await built.app.close();
  if (pool) await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await built.app.listen({ port, host });
