/**
 * PostgreSQL-backed repositories behind the store interfaces in ./store.ts.
 *
 * This is the persistence the platform ships with: when DATABASE_URL is set,
 * server.ts runs the @code-brothers/database migrations and builds the API
 * on these stores instead of the in-memory ones, so the owner account,
 * workflows, credentials, webhooks, audit log and run history all survive
 * a restart. When DATABASE_URL is unset the API falls back to the
 * in-memory stores with a loud warning (local dev / tests only — nothing
 * survives a restart there).
 *
 * Mapping notes (the schema is owned by @code-brothers/database, spec §9):
 * - EncryptedSecret <-> credentials bytea columns: every base64 field is
 *   decoded to a Buffer on write and re-encoded on read. The DEK-wrap GCM
 *   auth tag lives in dek_wrap_auth_tag (migration 0015 — the original
 *   schema had no column for it, so a credential written without it could
 *   never be decrypted back).
 * - users.totp_secret_encrypted / webhooks.hmac_secret_encrypted are TEXT:
 *   the whole EncryptedSecret is stored there as JSON.
 * - Engine statuses are mapped to the executions CHECK constraint:
 *   'error' | 'partial' -> 'failed' (steps carry the detail); the reverse
 *   mapping restores 'error' on read.
 * - Timestamps come back from pg as Date objects; the records expose ISO
 *   strings, exactly like the in-memory stores.
 */
import type { Pool, PoolClient } from '@code-brothers/database';
import { runMigrations } from '@code-brothers/database';
import type { EncryptedSecret } from '@code-brothers/security';
import type {
  ExecutionRecord,
  ExecutionStep,
  WorkflowEdge,
  WorkflowNodeInstance,
  WorkflowSettings,
} from '@code-brothers/core';
import type {
  AuditLog,
  AuditLogEntry,
  CredentialRecord,
  CredentialsRepository,
  ExecutionsRepository,
  NonceCache,
  SessionRecord,
  SessionsRepository,
  StoredExecution,
  Stores,
  UserRecord,
  UsersRepository,
  WebhookRecord,
  WebhooksRepository,
  WorkflowRecord,
  WorkflowVersionRecord,
  WorkflowsRepository,
} from './store.js';
import { PlatformState } from './store.js';

const VECTOR_MIGRATION = '0008_embeddings_vector.sql';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const iso = (value: Date | string | null | undefined): string | undefined => {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const isoOrNull = (value: Date | string | null | undefined): string | null => {
  const out = iso(value);
  return out === undefined ? null : out;
};

/** pg returns jsonb already parsed; tolerate a raw string just in case. */
function asJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

const toJsonb = (value: unknown): string => JSON.stringify(value ?? null);

function b64ToBuffer(value: string | undefined): Buffer {
  return Buffer.from(value ?? '', 'base64');
}
function bufferToB64(value: Buffer | null | undefined): string {
  return value ? value.toString('base64') : '';
}

/** Decode an EncryptedSecret from a credentials row (bytea columns). */
function secretFromCredentialRow(row: Record<string, unknown>): EncryptedSecret {
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    ciphertext: bufferToB64(row['ciphertext'] as Buffer | null),
    iv: bufferToB64(row['iv'] as Buffer | null),
    authTag: bufferToB64(row['auth_tag'] as Buffer | null),
    wrappedDek: bufferToB64(row['dek_wrapped'] as Buffer | null),
    wrapIv: bufferToB64(row['dek_iv'] as Buffer | null),
    wrapAuthTag: bufferToB64(row['dek_wrap_auth_tag'] as Buffer | null),
  };
}

/** Encode an EncryptedSecret into credentials bytea column values. */
function secretToCredentialColumns(secret: EncryptedSecret): Record<string, Buffer> {
  return {
    ciphertext: b64ToBuffer(secret.ciphertext),
    iv: b64ToBuffer(secret.iv),
    auth_tag: b64ToBuffer(secret.authTag),
    dek_wrapped: b64ToBuffer(secret.wrappedDek),
    dek_iv: b64ToBuffer(secret.wrapIv),
    dek_wrap_auth_tag: b64ToBuffer(secret.wrapAuthTag),
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function userFromRow(row: Record<string, unknown>): UserRecord {
  const totpRaw = row['totp_secret_encrypted'] as string | null;
  let totpSecret: EncryptedSecret | undefined;
  if (totpRaw) {
    try {
      totpSecret = JSON.parse(totpRaw) as EncryptedSecret;
    } catch {
      totpSecret = undefined;
    }
  }
  return {
    id: String(row['id']),
    email: String(row['email']),
    passwordHash: String(row['password_hash']),
    displayName: (row['display_name'] as string | null) ?? undefined,
    role: row['role'] as UserRecord['role'],
    locale: String(row['locale'] ?? 'en'),
    totpSecret,
    totpEnabled: Boolean(row['totp_enabled']),
    isActive: Boolean(row['is_active']),
    lastLoginAt: iso(row['last_login_at'] as Date | null),
    createdAt: iso(row['created_at'] as Date) ?? new Date().toISOString(),
    updatedAt: iso(row['updated_at'] as Date) ?? new Date().toISOString(),
  };
}

class PgUsersRepository implements UsersRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: Omit<UserRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<UserRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO users (email, password_hash, display_name, role, locale,
                          totp_secret_encrypted, totp_enabled, is_active, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.email.toLowerCase(),
        input.passwordHash,
        input.displayName ?? null,
        input.role,
        input.locale,
        input.totpSecret ? JSON.stringify(input.totpSecret) : null,
        input.totpEnabled,
        input.isActive,
        input.lastLoginAt ? new Date(input.lastLoginAt) : null,
      ],
    );
    return userFromRow(rows[0] as Record<string, unknown>);
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? userFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE email = $1', [
      email.toLowerCase(),
    ]);
    return rows[0] ? userFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async findOwner(): Promise<UserRecord | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM users WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1",
    );
    return rows[0] ? userFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async update(id: string, patch: Partial<UserRecord>): Promise<UserRecord | undefined> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.email !== undefined) push('email', patch.email.toLowerCase());
    if (patch.passwordHash !== undefined) push('password_hash', patch.passwordHash);
    if (patch.displayName !== undefined) push('display_name', patch.displayName);
    if (patch.role !== undefined) push('role', patch.role);
    if (patch.locale !== undefined) push('locale', patch.locale);
    if (patch.totpSecret !== undefined) {
      push('totp_secret_encrypted', patch.totpSecret ? JSON.stringify(patch.totpSecret) : null);
    }
    if (patch.totpEnabled !== undefined) push('totp_enabled', patch.totpEnabled);
    if (patch.isActive !== undefined) push('is_active', patch.isActive);
    if (patch.lastLoginAt !== undefined) {
      push('last_login_at', patch.lastLoginAt ? new Date(patch.lastLoginAt) : null);
    }
    if (sets.length === 0) return this.findById(id);
    push('updated_at', new Date());
    const { rows } = await this.pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length + 1} RETURNING *`,
      [...values, id],
    );
    return rows[0] ? userFromRow(rows[0] as Record<string, unknown>) : undefined;
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sessionFromRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    tokenHash: String(row['token_hash']),
    deviceName: (row['device_name'] as string | null) ?? undefined,
    userAgent: (row['user_agent'] as string | null) ?? undefined,
    ipAddress: (row['ip_address'] as string | null) ?? undefined,
    expiresAt: iso(row['expires_at'] as Date) ?? new Date().toISOString(),
    revokedAt: iso(row['revoked_at'] as Date | null),
    createdAt: iso(row['created_at'] as Date) ?? new Date().toISOString(),
  };
}

class PgSessionsRepository implements SessionsRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: Omit<SessionRecord, 'id' | 'createdAt'>): Promise<SessionRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO sessions (user_id, token_hash, device_name, user_agent, ip_address, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.userId,
        input.tokenHash,
        input.deviceName ?? null,
        input.userAgent ?? null,
        input.ipAddress ?? null,
        new Date(input.expiresAt),
        input.revokedAt ? new Date(input.revokedAt) : null,
      ],
    );
    return sessionFromRow(rows[0] as Record<string, unknown>);
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM sessions WHERE token_hash = $1', [
      tokenHash,
    ]);
    return rows[0] ? sessionFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async listByUser(userId: string): Promise<SessionRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM sessions WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return (rows as Record<string, unknown>[]).map(sessionFromRow);
  }

  async revoke(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [id],
    );
    return (rowCount ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function credentialFromRow(row: Record<string, unknown>): CredentialRecord {
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    provider: String(row['provider']),
    name: String(row['name']),
    kind: row['kind'] as CredentialRecord['kind'],
    encrypted: secretFromCredentialRow(row),
    createdAt: iso(row['created_at'] as Date) ?? new Date().toISOString(),
    updatedAt: iso(row['updated_at'] as Date) ?? new Date().toISOString(),
  };
}

class PgCredentialsRepository implements CredentialsRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    input: Omit<CredentialRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<CredentialRecord> {
    const cols = secretToCredentialColumns(input.encrypted);
    const { rows } = await this.pool.query(
      `INSERT INTO credentials (user_id, provider, name, kind, ciphertext, iv, auth_tag,
                               dek_wrapped, dek_iv, dek_wrap_auth_tag, key_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)
       RETURNING *`,
      [
        input.userId,
        input.provider,
        input.name,
        input.kind,
        cols['ciphertext'],
        cols['iv'],
        cols['auth_tag'],
        cols['dek_wrapped'],
        cols['dek_iv'],
        cols['dek_wrap_auth_tag'],
      ],
    );
    return credentialFromRow(rows[0] as Record<string, unknown>);
  }

  async findById(id: string): Promise<CredentialRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM credentials WHERE id = $1', [id]);
    return rows[0] ? credentialFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async listByUser(userId: string): Promise<CredentialRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM credentials WHERE user_id = $1 ORDER BY created_at ASC',
      [userId],
    );
    return (rows as Record<string, unknown>[]).map(credentialFromRow);
  }

  async findByName(userId: string, name: string): Promise<CredentialRecord | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM credentials WHERE user_id = $1 AND name = $2',
      [userId, name],
    );
    return rows[0] ? credentialFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM credentials WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

function workflowFromRow(row: Record<string, unknown>): WorkflowRecord {
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    name: String(row['name']),
    description: (row['description'] as string | null) ?? undefined,
    nodes: asJson<WorkflowNodeInstance[]>(row['nodes'], []),
    edges: asJson<WorkflowEdge[]>(row['edges'], []),
    settings: asJson<WorkflowSettings>(row['settings'], {}),
    isActive: Boolean(row['is_active']),
    currentVersion: Number(row['current_version'] ?? 1),
    tags: (row['tags'] as string[] | null) ?? [],
    createdAt: iso(row['created_at'] as Date) ?? new Date().toISOString(),
    updatedAt: iso(row['updated_at'] as Date) ?? new Date().toISOString(),
  };
}

function versionFromRow(row: Record<string, unknown>): WorkflowVersionRecord {
  return {
    id: String(row['id']),
    workflowId: String(row['workflow_id']),
    version: Number(row['version']),
    nodes: asJson<WorkflowNodeInstance[]>(row['nodes'], []),
    edges: asJson<WorkflowEdge[]>(row['edges'], []),
    settings: asJson<WorkflowSettings>(row['settings'], {}),
    comment: (row['comment'] as string | null) ?? undefined,
    createdBy: (row['created_by'] as string | null) ?? undefined,
    createdAt: iso(row['created_at'] as Date) ?? new Date().toISOString(),
  };
}

async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

class PgWorkflowsRepository implements WorkflowsRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    input: Omit<WorkflowRecord, 'id' | 'createdAt' | 'updatedAt' | 'currentVersion'>,
  ): Promise<WorkflowRecord> {
    return withTx(this.pool, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO workflows (user_id, name, description, nodes, edges, settings, is_active, current_version, tags)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, 1, $8)
         RETURNING *`,
        [
          input.userId,
          input.name,
          input.description ?? null,
          toJsonb(input.nodes),
          toJsonb(input.edges),
          toJsonb(input.settings),
          input.isActive,
          input.tags,
        ],
      );
      const record = workflowFromRow(rows[0] as Record<string, unknown>);
      await client.query(
        `INSERT INTO workflow_versions (workflow_id, version, nodes, edges, settings, created_by)
         VALUES ($1, 1, $2::jsonb, $3::jsonb, $4::jsonb, $5)`,
        [
          record.id,
          toJsonb(input.nodes),
          toJsonb(input.edges),
          toJsonb(input.settings),
          input.userId,
        ],
      );
      return record;
    });
  }

  async findById(id: string): Promise<WorkflowRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM workflows WHERE id = $1', [id]);
    return rows[0] ? workflowFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async listByUser(userId: string): Promise<WorkflowRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM workflows WHERE user_id = $1 ORDER BY created_at ASC',
      [userId],
    );
    return (rows as Record<string, unknown>[]).map(workflowFromRow);
  }

  async updateMeta(
    id: string,
    patch: Partial<Pick<WorkflowRecord, 'name' | 'description' | 'tags'>>,
  ): Promise<WorkflowRecord | undefined> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.description !== undefined) push('description', patch.description);
    if (patch.tags !== undefined) push('tags', patch.tags);
    if (sets.length === 0) return this.findById(id);
    push('updated_at', new Date());
    const { rows } = await this.pool.query(
      `UPDATE workflows SET ${sets.join(', ')} WHERE id = $${values.length + 1} RETURNING *`,
      [...values, id],
    );
    return rows[0] ? workflowFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async saveVersion(
    id: string,
    graph: { nodes: WorkflowNodeInstance[]; edges: WorkflowEdge[]; settings: WorkflowSettings },
    comment: string | undefined,
    createdBy: string | undefined,
  ): Promise<WorkflowRecord | undefined> {
    return withTx(this.pool, async (client) => {
      const { rows } = await client.query(
        `UPDATE workflows
         SET nodes = $1::jsonb, edges = $2::jsonb, settings = $3::jsonb,
             current_version = current_version + 1, updated_at = now()
         WHERE id = $4
         RETURNING *`,
        [toJsonb(graph.nodes), toJsonb(graph.edges), toJsonb(graph.settings), id],
      );
      if (!rows[0]) return undefined;
      const record = workflowFromRow(rows[0] as Record<string, unknown>);
      await client.query(
        `INSERT INTO workflow_versions (workflow_id, version, nodes, edges, settings, comment, created_by)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)`,
        [
          id,
          record.currentVersion,
          toJsonb(graph.nodes),
          toJsonb(graph.edges),
          toJsonb(graph.settings),
          comment ?? null,
          createdBy ?? null,
        ],
      );
      return record;
    });
  }

  async setActive(id: string, isActive: boolean): Promise<WorkflowRecord | undefined> {
    const { rows } = await this.pool.query(
      'UPDATE workflows SET is_active = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [isActive, id],
    );
    return rows[0] ? workflowFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM workflows WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async listVersions(workflowId: string): Promise<WorkflowVersionRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM workflow_versions WHERE workflow_id = $1 ORDER BY version ASC',
      [workflowId],
    );
    return (rows as Record<string, unknown>[]).map(versionFromRow);
  }

  async getVersion(workflowId: string, version: number): Promise<WorkflowVersionRecord | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM workflow_versions WHERE workflow_id = $1 AND version = $2',
      [workflowId, version],
    );
    return rows[0] ? versionFromRow(rows[0] as Record<string, unknown>) : undefined;
  }
}

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------

/** Engine 'error'/'partial' have no DB counterpart — both are failures. */
const toDbExecutionStatus = (status: ExecutionRecord['status']): string =>
  status === 'success' ? 'success' : 'failed';
const fromDbExecutionStatus = (status: string): ExecutionRecord['status'] =>
  status === 'success' ? 'success' : 'error';
const toDbStepStatus = (status: ExecutionStep['status']): string =>
  status === 'error' ? 'failed' : status;
const fromDbStepStatus = (status: string): ExecutionStep['status'] => {
  if (status === 'failed') return 'error';
  if (status === 'success' || status === 'skipped') return status;
  return 'skipped';
};

class PgExecutionsRepository implements ExecutionsRepository {
  constructor(private readonly pool: Pool) {}

  async add(execution: StoredExecution): Promise<void> {
    await withTx(this.pool, async (client) => {
      const output = execution.workflowName ? { workflowName: execution.workflowName } : null;
      await client.query(
        `INSERT INTO executions (id, workflow_id, workflow_version, status, trigger_type,
                                input, output, error, started_at, finished_at, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)`,
        [
          execution.id,
          execution.workflowId,
          execution.workflowVersion ?? null,
          toDbExecutionStatus(execution.status),
          execution.triggerType,
          toJsonb({}),
          output ? toJsonb(output) : null,
          execution.error ?? null,
          new Date(execution.startedAt),
          new Date(execution.finishedAt),
          execution.durationMs,
        ],
      );
      for (const step of execution.steps) {
        const started = new Date(step.startedAt);
        const finished = new Date(started.getTime() + step.durationMs);
        await client.query(
          `INSERT INTO execution_steps (execution_id, node_id, node_type, status, input, output,
                                      error, attempt, started_at, finished_at, duration_ms)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11)`,
          [
            execution.id,
            step.nodeId,
            step.nodeType,
            toDbStepStatus(step.status),
            step.input === undefined ? null : toJsonb(step.input),
            step.output === undefined ? null : toJsonb(step.output),
            step.error ?? null,
            step.attempts,
            started,
            finished,
            step.durationMs,
          ],
        );
      }
    });
  }

  async findById(id: string): Promise<StoredExecution | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM executions WHERE id = $1', [id]);
    if (!rows[0]) return undefined;
    const steps = await this.loadSteps(id);
    return executionFromRow(rows[0] as Record<string, unknown>, steps);
  }

  async list(filter: { workflowId?: string; limit?: number } = {}): Promise<StoredExecution[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.workflowId) {
      values.push(filter.workflowId);
      where.push(`workflow_id = $${values.length}`);
    }
    let sql = 'SELECT * FROM executions';
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY started_at DESC';
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      sql += ` LIMIT $${values.length}`;
    }
    const { rows } = await this.pool.query(sql, values);
    const out: StoredExecution[] = [];
    for (const row of rows as Record<string, unknown>[]) {
      out.push(executionFromRow(row, await this.loadSteps(String(row['id']))));
    }
    return out;
  }

  private async loadSteps(executionId: string): Promise<ExecutionStep[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM execution_steps WHERE execution_id = $1 ORDER BY created_at ASC',
      [executionId],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      nodeId: String(row['node_id']),
      nodeName: String(row['node_id']),
      nodeType: String(row['node_type'] ?? ''),
      status: fromDbStepStatus(String(row['status'])),
      startedAt: iso(row['started_at'] as Date) ?? new Date().toISOString(),
      durationMs: Number(row['duration_ms'] ?? 0),
      attempts: Number(row['attempt'] ?? 1),
      input: asJson(row['input'], undefined),
      output: asJson(row['output'], undefined),
      error: (row['error'] as string | null) ?? undefined,
    }));
  }
}

function executionFromRow(row: Record<string, unknown>, steps: ExecutionStep[]): StoredExecution {
  const output = asJson<Record<string, unknown> | null>(row['output'], null);
  return {
    id: String(row['id']),
    workflowId: String(row['workflow_id']),
    workflowName:
      output && typeof output['workflowName'] === 'string'
        ? (output['workflowName'] as string)
        : undefined,
    status: fromDbExecutionStatus(String(row['status'])),
    startedAt: iso(row['started_at'] as Date) ?? new Date().toISOString(),
    finishedAt: iso(row['finished_at'] as Date) ?? new Date().toISOString(),
    durationMs: Number(row['duration_ms'] ?? 0),
    steps,
    error: (row['error'] as string | null) ?? undefined,
    triggerType: row['trigger_type'] as StoredExecution['triggerType'],
    workflowVersion:
      row['workflow_version'] === null || row['workflow_version'] === undefined
        ? undefined
        : Number(row['workflow_version']),
  };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function webhookFromRow(row: Record<string, unknown>): WebhookRecord {
  let hmacSecretEncrypted: EncryptedSecret;
  try {
    hmacSecretEncrypted = JSON.parse(String(row['hmac_secret_encrypted'])) as EncryptedSecret;
  } catch {
    hmacSecretEncrypted = {
      version: 1,
      algorithm: 'aes-256-gcm',
      ciphertext: '',
      iv: '',
      authTag: '',
      wrappedDek: '',
      wrapIv: '',
      wrapAuthTag: '',
    };
  }
  return {
    id: String(row['id']),
    workflowId: String(row['workflow_id']),
    slug: String(row['slug']),
    hmacSecretEncrypted,
    ipAllowlist: (row['ip_allowlist'] as string[] | null) ?? [],
    isActive: Boolean(row['is_active']),
    lastTriggeredAt: iso(row['last_triggered_at'] as Date | null),
    createdAt: iso(row['created_at'] as Date) ?? new Date().toISOString(),
    updatedAt: iso(row['updated_at'] as Date) ?? new Date().toISOString(),
  };
}

class PgWebhooksRepository implements WebhooksRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: Omit<WebhookRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<WebhookRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO webhooks (workflow_id, slug, hmac_secret_encrypted, ip_allowlist, is_active, last_triggered_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.workflowId,
        input.slug,
        JSON.stringify(input.hmacSecretEncrypted),
        input.ipAllowlist,
        input.isActive,
        input.lastTriggeredAt ? new Date(input.lastTriggeredAt) : null,
      ],
    );
    return webhookFromRow(rows[0] as Record<string, unknown>);
  }

  async findById(id: string): Promise<WebhookRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM webhooks WHERE id = $1', [id]);
    return rows[0] ? webhookFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async findBySlug(slug: string): Promise<WebhookRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM webhooks WHERE slug = $1', [slug]);
    return rows[0] ? webhookFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async list(): Promise<WebhookRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM webhooks ORDER BY created_at ASC');
    return (rows as Record<string, unknown>[]).map(webhookFromRow);
  }

  async update(id: string, patch: Partial<WebhookRecord>): Promise<WebhookRecord | undefined> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.workflowId !== undefined) push('workflow_id', patch.workflowId);
    if (patch.slug !== undefined) push('slug', patch.slug);
    if (patch.hmacSecretEncrypted !== undefined) {
      push('hmac_secret_encrypted', JSON.stringify(patch.hmacSecretEncrypted));
    }
    if (patch.ipAllowlist !== undefined) push('ip_allowlist', patch.ipAllowlist);
    if (patch.isActive !== undefined) push('is_active', patch.isActive);
    if (patch.lastTriggeredAt !== undefined) {
      push('last_triggered_at', patch.lastTriggeredAt ? new Date(patch.lastTriggeredAt) : null);
    }
    if (sets.length === 0) return this.findById(id);
    push('updated_at', new Date());
    const { rows } = await this.pool.query(
      `UPDATE webhooks SET ${sets.join(', ')} WHERE id = $${values.length + 1} RETURNING *`,
      [...values, id],
    );
    return rows[0] ? webhookFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM webhooks WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------
// Audit log (append-only)
// ---------------------------------------------------------------------------

class PgAuditLog implements AuditLog {
  constructor(private readonly pool: Pool) {}

  async append(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): Promise<AuditLogEntry> {
    const { rows } = await this.pool.query(
      `INSERT INTO security_audit_logs (user_id, event_type, severity, ip_address, user_agent, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING *`,
      [
        entry.userId ?? null,
        entry.eventType,
        entry.severity,
        entry.ipAddress ?? null,
        entry.userAgent ?? null,
        toJsonb(entry.details),
      ],
    );
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row['id']),
      userId: (row['user_id'] as string | null) ?? undefined,
      eventType: String(row['event_type']),
      severity: row['severity'] as AuditLogEntry['severity'],
      ipAddress: (row['ip_address'] as string | null) ?? undefined,
      userAgent: (row['user_agent'] as string | null) ?? undefined,
      details: asJson<Record<string, unknown>>(row['details'], {}),
      createdAt: iso(row['created_at'] as Date) ?? new Date().toISOString(),
    };
  }

  async list(filter: { eventType?: string; limit?: number } = {}): Promise<AuditLogEntry[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.eventType) {
      values.push(filter.eventType);
      where.push(`event_type = $${values.length}`);
    }
    let sql = 'SELECT * FROM security_audit_logs';
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC';
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      sql += ` LIMIT $${values.length}`;
    }
    const { rows } = await this.pool.query(sql, values);
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: String(row['id']),
      userId: (row['user_id'] as string | null) ?? undefined,
      eventType: String(row['event_type']),
      severity: row['severity'] as AuditLogEntry['severity'],
      ipAddress: (row['ip_address'] as string | null) ?? undefined,
      userAgent: (row['user_agent'] as string | null) ?? undefined,
      details: asJson<Record<string, unknown>>(row['details'], {}),
      createdAt: iso(row['created_at'] as Date) ?? new Date().toISOString(),
    }));
  }
}

// ---------------------------------------------------------------------------
// Replay-nonce cache (unique constraint does the work)
// ---------------------------------------------------------------------------

class PgNonceCache implements NonceCache {
  constructor(private readonly pool: Pool) {}

  async checkAndAdd(key: string, ttlMs: number): Promise<boolean> {
    const [webhookId, ...rest] = key.split(':');
    const nonce = rest.join(':');
    if (!webhookId || !nonce) return false;
    // Fresh insert wins. On conflict the nonce was seen before — unless the
    // recorded row is older than the TTL, in which case it is pruned and
    // the nonce counts as fresh again.
    const inserted = await this.pool.query(
      `INSERT INTO webhook_replay_nonces (webhook_id, nonce) VALUES ($1, $2)
       ON CONFLICT (webhook_id, nonce) DO NOTHING
       RETURNING id`,
      [webhookId, nonce],
    );
    if ((inserted.rowCount ?? 0) > 0) return true;
    const { rows } = await this.pool.query(
      'SELECT seen_at FROM webhook_replay_nonces WHERE webhook_id = $1 AND nonce = $2',
      [webhookId, nonce],
    );
    const seenAt = rows[0]?.['seen_at'] as Date | undefined;
    if (seenAt && Date.now() - seenAt.getTime() > ttlMs) {
      await this.pool.query(
        'DELETE FROM webhook_replay_nonces WHERE webhook_id = $1 AND nonce = $2',
        [webhookId, nonce],
      );
      const retried = await this.pool.query(
        `INSERT INTO webhook_replay_nonces (webhook_id, nonce) VALUES ($1, $2)
         ON CONFLICT (webhook_id, nonce) DO NOTHING
         RETURNING id`,
        [webhookId, nonce],
      );
      return (retried.rowCount ?? 0) > 0;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Factory + migration helper
// ---------------------------------------------------------------------------

/** Pg-backed kill switch (spec §8): the single platform_state row, shared
 * with the worker process so a freeze is visible everywhere. */
class PgPlatformState implements PlatformState {
  constructor(private readonly pool: Pool) {}

  async halt(): Promise<void> {
    await this.pool.query(
      `UPDATE platform_state
          SET halted = true, halted_at = now(), updated_at = now()
        WHERE id = 'platform'`,
    );
  }

  async resume(): Promise<void> {
    await this.pool.query(
      `UPDATE platform_state
          SET halted = false, halted_at = NULL, updated_at = now()
        WHERE id = 'platform'`,
    );
  }

  async isHalted(): Promise<boolean> {
    const { rows } = await this.pool.query(
      "SELECT halted FROM platform_state WHERE id = 'platform'",
    );
    return Boolean(rows[0]?.['halted']);
  }
}

// ---------------------------------------------------------------------------
// Factory + migration helper
// ---------------------------------------------------------------------------

/** Build a full set of Pg-backed stores sharing one pool. */
export function createPgStores(pool: Pool): Stores {
  return {
    users: new PgUsersRepository(pool),
    sessions: new PgSessionsRepository(pool),
    credentials: new PgCredentialsRepository(pool),
    workflows: new PgWorkflowsRepository(pool),
    executions: new PgExecutionsRepository(pool),
    webhooks: new PgWebhooksRepository(pool),
    audit: new PgAuditLog(pool),
    nonces: new PgNonceCache(pool),
    platform: new PgPlatformState(pool),
  };
}

/**
 * Apply the @code-brothers/database migrations to a pool, tolerating a
 * database without the pgvector extension: if the vector migration fails,
 * retry with it excluded (it is only needed for vector search; the rest
 * of the schema works without it).
 */
export async function runMigrationsTolerant(pool: Pool): Promise<string[]> {
  try {
    return await runMigrations(pool);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/vector|extension/i.test(message)) {
      return runMigrations(pool, { exclude: [VECTOR_MIGRATION] });
    }
    throw err;
  }
}
