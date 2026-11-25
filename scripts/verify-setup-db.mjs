/**
 * Database setup for scripts/verify-templates.mjs.
 *
 * Usage: node scripts/verify-setup-db.mjs <connectionString> <userId>
 *
 * Runs the @code-brothers/database migrations (excluding the pgvector
 * migration on databases without the extension) and seeds the local
 * tables the templates' SQL touches:
 *   - products (template-03 local stock leg)
 *   - customers_crm (template-04 risk lookup)
 *   - payment_tids is written by template-02 itself; only the table
 *     must exist (migrations create it).
 *
 * This script is test scaffolding, not product code — it uses the
 * workspace's own pg driver via @code-brothers/database.
 */
import { createPool, runMigrations } from '@code-brothers/database';

const [connectionString, userId] = process.argv.slice(2);
if (!connectionString || !userId) {
  console.error('usage: node scripts/verify-setup-db.mjs <connectionString> <userId>');
  process.exit(2);
}

const pool = createPool(connectionString);
try {
  // Skip the pgvector migration when the extension is not installed
  // (plain PostgreSQL, e.g. the stock Ubuntu package).
  const hasVector = await pool
    .query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")
    .then((r) => r.rows.length > 0)
    .catch(() => false);
  const applied = await runMigrations(pool, {
    exclude: hasVector ? [] : ['0008_embeddings_vector.sql'],
  });
  console.log(`migrations applied: ${applied.length ? applied.join(', ') : '(none — already applied)'}${hasVector ? '' : ' (pgvector migration skipped: extension not installed)'}`);

  // The API under test runs on in-memory stores, so its owner row does not
  // exist in Postgres — insert a matching stub so the FKs below are happy.
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1, $2, 'argon2id-placeholder', 'owner')
     ON CONFLICT (id) DO NOTHING`,
    [userId, `owner-${String(userId).slice(0, 8)}@example.com`],
  );
  // The mock OCR always returns the same TID, so a previous run's row would
  // trip the duplicate-payment shield. Start each verification run clean.
  await pool.query('TRUNCATE payment_tids');
  await pool.query(
    `INSERT INTO products (user_id, master_sku, title, stock, price)
     VALUES ($1, 'SHOE-RED', 'Red Shoes', 10, 2500),
            ($1, 'SHOE-BLU', 'Blue Shoes', 10, 2200)
     ON CONFLICT (user_id, master_sku) DO UPDATE SET stock = EXCLUDED.stock`,
    [userId],
  );
  await pool.query(
    `INSERT INTO customers_crm (user_id, name, phone, preferred_language, cod_risk_score)
     VALUES ($1, 'Ali Raza', '923009999999', 'en', 10)
     ON CONFLICT (user_id, phone) DO UPDATE SET cod_risk_score = EXCLUDED.cod_risk_score`,
    [userId],
  );
  console.log('seeded: products SHOE-RED/SHOE-BLU (stock 10), customer 923009999999 (risk 10)');
} finally {
  await pool.end();
}
