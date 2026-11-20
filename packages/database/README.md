# @code-brothers/database

PostgreSQL + pgvector schema and migration runner for the **Code Brothers**
platform — spec §9 ("Database Entities"). Plain SQL migrations, a small
TypeScript runner built on `pg`, and tests that run against
[pg-mem](https://github.com/oguimbal/pg-mem) so no live database is needed.

## Tables

| Migration | Tables | Purpose |
| :--- | :--- | :--- |
| `0001_users_sessions.sql` | `users`, `sessions` | Accounts (Argon2id password hashes, TOTP 2FA secret, preferred locale, RBAC role) and active device sessions (hashed tokens only) |
| `0002_credentials.sql` | `credentials` | AES-256-GCM envelope-encrypted API keys / OAuth tokens: ciphertext, IV, auth tag, wrapped DEK, rotation metadata |
| `0003_workflows.sql` | `workflows`, `workflow_versions` | Saved JSON DAG graphs (`nodes`/`edges`/`settings` as JSONB, `is_active`) with full revision history |
| `0004_webhooks.sql` | `webhooks`, `webhook_replay_nonces` | Slug → workflow registry with encrypted HMAC secret and IP allowlist; replay-nonce cache with a unique constraint per webhook |
| `0005_executions.sql` | `executions`, `execution_steps` | Redacted run history: run-level and node-level inputs/outputs, durations, errors |
| `0006_ai_assistants.sql` | `ai_assistants`, `ai_memories` | Assistant personas + least-privilege tool whitelists; per-user chat history and summaries |
| `0007_knowledge.sql` | `knowledge_documents`, `embeddings` | Uploaded docs / synced catalogs and their text chunks, isolated by `workspace_id` |
| `0008_embeddings_vector.sql` | *(alters `embeddings`)* | pgvector: creates the `vector` extension and the `embedding vector(1024)` column (bge-m3 dimensions) + IVFFlat cosine index |
| `0009_whatsapp_sessions.sql` | `whatsapp_sessions` | Multi-number WhatsApp sessions: encrypted QR session state, engine (`qr`/`cloud_api`), daily anti-ban counters |
| `0010_sku_mappings.sql` | `sku_mappings` | Master SKU ↔ Shopify / Daraz / local SKU link; unique per merchant + channel pair |
| `0011_customers_payments.sql` | `customers_crm`, `payment_tids` | Customer 360 (preferred language, COD risk score) and the verified payment-TID ledger — `tid` is globally unique, which is the duplicate-payment shield |
| `0012_security.sql` | `security_audit_logs`, `ip_bans` | Append-only security audit trail (no `updated_at`, rows are never modified) and the brute-force IP blocklist |
| `0013_polling_state.sql` | `polling_state` | Last-checked timestamps/cursors for the Daraz & YouTube polling triggers |

Conventions used throughout: `uuid` primary keys defaulting to
`gen_random_uuid()` (built into PostgreSQL 13+), `timestamptz`
`created_at`/`updated_at` defaulting to `now()`, foreign keys where the
spec implies a relationship, and JSONB for graph/settings/metadata
payloads. `updated_at` is refreshed by the application layer (the spec's
ORM direction is Drizzle/Prisma, which manage it in code).

## Running migrations

```ts
import { createPool, runMigrations, listApplied } from '@code-brothers/database';

const pool = createPool(process.env.DATABASE_URL!);
const appliedNow = await runMigrations(pool); // string[] of newly applied files
console.log(await listApplied(pool));         // all applied migration names
```

- Files are applied in filename order, each inside its own transaction;
  a failed migration rolls back and aborts the run with the file name in
  the error.
- Applied files are recorded in a `schema_migrations` table with a
  SHA-256 checksum. Re-running applies nothing (idempotent).
- Options: `runMigrations(pool, { dir, exclude, table })`.
  - `dir` — override the migrations folder (defaults to this package's
    `migrations/`).
  - `exclude` — file names (or a predicate) to skip, e.g.
    `exclude: ['0008_embeddings_vector.sql']` on a database without
    pgvector. Skipped files are **not** recorded as applied, so a later
    run without the exclusion still applies them.
  - `table` — bookkeeping table name (default `schema_migrations`).

## Tests

```bash
npm test   # tsc build + node --test on the compiled tests
```

Tests run entirely against pg-mem. Two harness-only adaptations (the
migrations themselves are plain PostgreSQL):

- pg-mem does not implement `gen_random_uuid()`, so the test registers it
  backed by `node:crypto` — with `impure: true`, otherwise pg-mem caches
  one value per statement and every row would share an id.
- The pgvector migration (`0008`) is excluded via the runner's `exclude`
  option because pg-mem has no pgvector extension.
