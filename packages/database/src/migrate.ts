/**
 * Migration runner for @code-brothers/database.
 *
 * Reads `*.sql` files from the migrations directory in filename order,
 * applies each unapplied file inside its own transaction, and records it
 * in a `schema_migrations` bookkeeping table (name + sha256 checksum).
 * Running it again applies nothing — it is fully idempotent.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export interface RunMigrationsOptions {
  /** Directory containing the `*.sql` migration files. Defaults to the package's `migrations/` folder. */
  dir?: string;
  /**
   * Files to skip: either an array of file names (e.g. `['0008_embeddings_vector.sql']`
   * on databases without pgvector) or a predicate over the file name.
   * Skipped files are NOT recorded as applied, so a later run without the
   * exclusion will still apply them.
   */
  exclude?: string[] | ((fileName: string) => boolean);
  /** Bookkeeping table name. Defaults to `schema_migrations`. */
  table?: string;
}

export interface ListAppliedOptions {
  /** Bookkeeping table name. Defaults to `schema_migrations`. */
  table?: string;
}

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const DEFAULT_TABLE = 'schema_migrations';
const SAFE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

function resolveTableName(table: string | undefined): string {
  const name = table ?? DEFAULT_TABLE;
  if (!SAFE_TABLE_NAME.test(name)) {
    throw new Error(`Invalid migrations table name: ${name}`);
  }
  return name;
}

function isExcluded(
  exclude: RunMigrationsOptions['exclude'],
  fileName: string,
): boolean {
  if (!exclude) return false;
  if (typeof exclude === 'function') return exclude(fileName);
  return exclude.includes(fileName);
}

async function ensureMigrationsTable(
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  table: string,
): Promise<void> {
  // Existence check first instead of CREATE TABLE IF NOT EXISTS: some
  // PostgreSQL doubles (pg-mem) mishandle IF NOT EXISTS on existing tables,
  // and the check is portable to real PostgreSQL as well.
  const exists = await query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  if (exists.rows.length > 0) return;
  await query(
    `CREATE TABLE ${table} (
       name text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

/** Names of the migrations recorded as applied, in application order. Returns [] on a fresh database. */
export async function listApplied(
  pool: Pool,
  opts: ListAppliedOptions = {},
): Promise<string[]> {
  const table = resolveTableName(opts.table);
  const exists = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  if (exists.rows.length === 0) return [];
  const result = await pool.query(
    `SELECT name FROM ${table} ORDER BY applied_at, name`,
  );
  return result.rows.map((row: { name: string }) => row.name);
}

/**
 * Apply every pending migration in filename order.
 * Returns the names of the migrations applied by this run ([] when the
 * database is already up to date).
 */
export async function runMigrations(
  pool: Pool,
  opts: RunMigrationsOptions = {},
): Promise<string[]> {
  const dir = opts.dir ?? DEFAULT_MIGRATIONS_DIR;
  const table = resolveTableName(opts.table);
  const files = (await readdir(dir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(
      (text, params) => client.query(text, params),
      table,
    );
    const appliedRows = await client.query(`SELECT name FROM ${table}`);
    const applied = new Set<string>(
      appliedRows.rows.map((row: { name: string }) => row.name),
    );

    const appliedNow: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      if (isExcluded(opts.exclude, file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO ${table} (name, checksum) VALUES ($1, $2)`,
          [file, checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      appliedNow.push(file);
    }
    return appliedNow;
  } finally {
    client.release();
  }
}
