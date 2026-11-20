/**
 * @code-brothers/database — PostgreSQL + pgvector schema and migrations
 * for the Code Brothers platform (spec §9).
 */
import { Pool } from 'pg';

export { runMigrations, listApplied } from './migrate.js';
export type { RunMigrationsOptions, ListAppliedOptions } from './migrate.js';

/** Create a `pg` connection pool from a PostgreSQL connection string. */
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}
