/**
 * Postgres adapters for the worker process (gap 6): the same tables the
 * API reads/writes, so the worker and the API see one platform.
 *
 *   - PgWorkflowProvider  — active workflows (Scheduler arming + runs)
 *   - PgExecutionSink     — finished executions (visible in the API's
 *                           /api/executions history)
 *   - PgPollingStateStore — durable poll cursors (spec §9 polling_state)
 *   - PgPlatformHalt      — the shared kill-switch row (migration 0016)
 *   - createPgCredentialsProvider — vault-backed credentials per owner,
 *     the same decrypt path the API uses
 *
 * The SQL mirrors apps/api/src/pg-stores.ts (the API's repositories).
 * The worker cannot import that file (separate workspace), so the few
 * statements the worker needs live here instead of duplicating the
 * whole repository layer.
 */
import type { Pool } from 'pg';
import {
  decryptSecret,
  type EncryptedSecret,
} from '@code-brothers/security';
import type { WorkflowDefinition, WorkflowEdge, WorkflowNodeInstance, WorkflowSettings } from '@code-brothers/core';
import type { ExecutionSink, LoadedWorkflow, StoredExecution, WorkflowProvider } from './types.js';
import type { PollingStateStore } from './poller.js';

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

function toJsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function bufferToB64(value: Buffer | null): string {
  return value ? value.toString('base64') : '';
}

function toDbExecutionStatus(status: StoredExecution['status']): string {
  // Mirrors apps/api/src/pg-stores.ts: the executions CHECK constraint
  // accepts 'success' | 'failed'.
  return status === 'success' ? 'success' : 'failed';
}

function toDbStepStatus(status: string): string {
  // Mirrors apps/api/src/pg-stores.ts: 'error' -> 'failed', the rest pass.
  return status === 'error' ? 'failed' : status;
}

function loadedFromRow(row: Record<string, unknown>): LoadedWorkflow {
  return {
    definition: {
      id: String(row['id']),
      name: String(row['name']),
      nodes: asJson<WorkflowNodeInstance[]>(row['nodes'], []),
      edges: asJson<WorkflowEdge[]>(row['edges'], []),
      settings: asJson<WorkflowSettings>(row['settings'], {}),
    } satisfies WorkflowDefinition,
    userId: String(row['user_id']),
    currentVersion: Number(row['current_version'] ?? 1),
  };
}

export class PgWorkflowProvider implements WorkflowProvider {
  constructor(private readonly pool: Pool) {}

  async getWorkflow(id: string): Promise<LoadedWorkflow | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM workflows WHERE id = $1', [id]);
    return rows[0] ? loadedFromRow(rows[0] as Record<string, unknown>) : undefined;
  }

  async listActive(): Promise<LoadedWorkflow[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM workflows WHERE is_active = true ORDER BY created_at ASC',
    );
    return (rows as Record<string, unknown>[]).map(loadedFromRow);
  }
}

export class PgExecutionSink implements ExecutionSink {
  constructor(private readonly pool: Pool) {}

  async record(execution: StoredExecution): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
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
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Durable poll cursors (spec §9 polling_state). Poller keys are
 * `source:account_ref`, e.g. `daraz:` (default seller) or
 * `youtube:UCxxxx` — the table's UNIQUE (source, account_ref) maps
 * straight onto that split.
 */
export class PgPollingStateStore implements PollingStateStore {
  constructor(private readonly pool: Pool) {}

  private splitKey(key: string): { source: string; accountRef: string } {
    const [source = '', ...rest] = key.split(':');
    return { source, accountRef: rest.join(':') };
  }

  async get(key: string): Promise<string | undefined> {
    const { source, accountRef } = this.splitKey(key);
    const { rows } = await this.pool.query(
      'SELECT cursor FROM polling_state WHERE source = $1 AND account_ref = $2',
      [source, accountRef],
    );
    const cursor = rows[0]?.['cursor'] as string | null | undefined;
    return cursor ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    const { source, accountRef } = this.splitKey(key);
    await this.pool.query(
      `INSERT INTO polling_state (source, account_ref, cursor, last_checked_at, state)
       VALUES ($1, $2, $3, now(), '{}')
       ON CONFLICT (source, account_ref)
       DO UPDATE SET cursor = EXCLUDED.cursor, last_checked_at = now(), updated_at = now()`,
      [source, accountRef, value],
    );
  }
}

/** Read-only view of the shared kill-switch row (migration 0016). */
export class PgPlatformHalt {
  constructor(private readonly pool: Pool) {}

  async isHalted(): Promise<boolean> {
    const { rows } = await this.pool.query(
      "SELECT halted FROM platform_state WHERE id = 'platform'",
    );
    return Boolean(rows[0]?.['halted']);
  }
}

/**
 * Vault-backed credentials provider for one owner — the same decrypt
 * path the API uses (AES-256-GCM envelope, master key). Returns
 * undefined when the credential does not exist or cannot be decrypted,
 * so the engine treats it as "not configured" instead of crashing.
 */
export function createPgCredentialsProvider(
  pool: Pool,
  masterKey: Buffer,
  userId: string,
): (name: string, nodeType: string) => Promise<Record<string, unknown> | undefined> {
  return async (name: string) => {
    const { rows } = await pool.query(
      'SELECT * FROM credentials WHERE user_id = $1 AND name = $2',
      [userId, name],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const secret: EncryptedSecret = {
      version: 1,
      algorithm: 'aes-256-gcm',
      ciphertext: bufferToB64(row['ciphertext'] as Buffer | null),
      iv: bufferToB64(row['iv'] as Buffer | null),
      authTag: bufferToB64(row['auth_tag'] as Buffer | null),
      wrappedDek: bufferToB64(row['dek_wrapped'] as Buffer | null),
      wrapIv: bufferToB64(row['dek_iv'] as Buffer | null),
      wrapAuthTag: bufferToB64(row['dek_wrap_auth_tag'] as Buffer | null),
    };
    let plain: string;
    try {
      plain = decryptSecret(secret, masterKey);
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(plain);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { value: plain };
    }
  };
}
