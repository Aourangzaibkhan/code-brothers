/**
 * API server entrypoint.
 *
 * - When DATABASE_URL is set, the PostgreSQL migrations owned by
 *   @code-brothers/database are applied before listening (the request
 *   handlers in this build run on the in-memory stores; the Pg-backed
 *   repositories slot in behind the same interfaces in ./store.ts).
 * - On first boot (no owner yet) the one-time setup token is printed to
 *   the console exactly once — claim the owner account with it at
 *   POST /api/setup/claim.
 */
import { buildApp } from './app.js';

const built = await buildApp({ logger: true });

if (process.env.DATABASE_URL) {
  const { createPool, runMigrations } = await import('@code-brothers/database');
  const pool = createPool(process.env.DATABASE_URL);
  const applied = await runMigrations(pool);
  if (applied.length > 0) {
    built.app.log.info({ applied }, 'database migrations applied');
  }
  await pool.end();
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
await built.app.listen({ port, host });
