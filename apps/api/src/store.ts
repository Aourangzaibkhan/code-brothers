/**
 * Persistence layer for the API server.
 *
 * Every store sits behind a small async interface that mirrors the
 * PostgreSQL schema owned by @code-brothers/database (spec §9, see
 * ./tables.ts). The in-memory implementations below are what local runs
 * and the test-suite use; a Pg-backed implementation only has to satisfy
 * the same interfaces.
 */
import { randomUUID } from 'node:crypto';
import type { EncryptedSecret } from '@code-brothers/security';
import type {
  ExecutionRecord,
  WorkflowEdge,
  WorkflowNodeInstance,
  WorkflowSettings,
} from '@code-brothers/core';

// ---------------------------------------------------------------------------
// Record shapes (one per table in the database schema)
// ---------------------------------------------------------------------------

export type UserRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface UserRecord {
  id: string;
  email: string;
  /** Argon2id PHC hash — never a plaintext password. */
  passwordHash: string;
  displayName?: string;
  role: UserRole;
  locale: string;
  /** Envelope-encrypted TOTP secret (vault record), never plaintext. */
  totpSecret?: EncryptedSecret;
  totpEnabled: boolean;
  isActive: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  /** SHA-256 hex of the opaque session token — never the raw token. */
  tokenHash: string;
  deviceName?: string;
  userAgent?: string;
  ipAddress?: string;
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}

export interface CredentialRecord {
  id: string;
  userId: string;
  provider: string;
  name: string;
  kind: 'api_key' | 'oauth' | 'basic' | 'custom';
  /** Envelope-encrypted secret payload (vault record). */
  encrypted: EncryptedSecret;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRecord {
  id: string;
  userId: string;
  name: string;
  description?: string;
  nodes: WorkflowNodeInstance[];
  edges: WorkflowEdge[];
  settings: WorkflowSettings;
  isActive: boolean;
  currentVersion: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVersionRecord {
  id: string;
  workflowId: string;
  version: number;
  nodes: WorkflowNodeInstance[];
  edges: WorkflowEdge[];
  settings: WorkflowSettings;
  comment?: string;
  createdBy?: string;
  createdAt: string;
}

export type TriggerType = 'manual' | 'webhook' | 'cron' | 'polling' | 'retry';

/** An engine ExecutionRecord plus the platform bookkeeping columns. */
export interface StoredExecution extends ExecutionRecord {
  triggerType: TriggerType;
  workflowVersion?: number;
}

export interface WebhookRecord {
  id: string;
  workflowId: string;
  slug: string;
  /** Envelope-encrypted HMAC signing secret (vault record). */
  hmacSecretEncrypted: EncryptedSecret;
  ipAllowlist: string[];
  isActive: boolean;
  lastTriggeredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type AuditSeverity = 'info' | 'warning' | 'critical';

export interface AuditLogEntry {
  id: string;
  userId?: string;
  eventType: string;
  severity: AuditSeverity;
  ipAddress?: string;
  userAgent?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------------

export interface UsersRepository {
  create(input: Omit<UserRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<UserRecord>;
  findById(id: string): Promise<UserRecord | undefined>;
  findByEmail(email: string): Promise<UserRecord | undefined>;
  findOwner(): Promise<UserRecord | undefined>;
  update(id: string, patch: Partial<UserRecord>): Promise<UserRecord | undefined>;
}

export interface SessionsRepository {
  create(input: Omit<SessionRecord, 'id' | 'createdAt'>): Promise<SessionRecord>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | undefined>;
  listByUser(userId: string): Promise<SessionRecord[]>;
  revoke(id: string): Promise<boolean>;
}

export interface CredentialsRepository {
  create(input: Omit<CredentialRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<CredentialRecord>;
  findById(id: string): Promise<CredentialRecord | undefined>;
  listByUser(userId: string): Promise<CredentialRecord[]>;
  findByName(userId: string, name: string): Promise<CredentialRecord | undefined>;
  delete(id: string): Promise<boolean>;
}

export interface WorkflowsRepository {
  /** Creates the workflow and its version-1 row atomically. */
  create(input: Omit<WorkflowRecord, 'id' | 'createdAt' | 'updatedAt' | 'currentVersion'>): Promise<WorkflowRecord>;
  findById(id: string): Promise<WorkflowRecord | undefined>;
  listByUser(userId: string): Promise<WorkflowRecord[]>;
  updateMeta(
    id: string,
    patch: Partial<Pick<WorkflowRecord, 'name' | 'description' | 'tags'>>,
  ): Promise<WorkflowRecord | undefined>;
  /** Replaces the graph, bumps currentVersion and appends a version row. */
  saveVersion(
    id: string,
    graph: { nodes: WorkflowNodeInstance[]; edges: WorkflowEdge[]; settings: WorkflowSettings },
    comment: string | undefined,
    createdBy: string | undefined,
  ): Promise<WorkflowRecord | undefined>;
  setActive(id: string, isActive: boolean): Promise<WorkflowRecord | undefined>;
  delete(id: string): Promise<boolean>;
  listVersions(workflowId: string): Promise<WorkflowVersionRecord[]>;
  getVersion(workflowId: string, version: number): Promise<WorkflowVersionRecord | undefined>;
}

export interface ExecutionsRepository {
  add(execution: StoredExecution): Promise<void>;
  findById(id: string): Promise<StoredExecution | undefined>;
  list(filter?: { workflowId?: string; limit?: number }): Promise<StoredExecution[]>;
}

export interface WebhooksRepository {
  create(input: Omit<WebhookRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<WebhookRecord>;
  findById(id: string): Promise<WebhookRecord | undefined>;
  findBySlug(slug: string): Promise<WebhookRecord | undefined>;
  list(): Promise<WebhookRecord[]>;
  update(id: string, patch: Partial<WebhookRecord>): Promise<WebhookRecord | undefined>;
  delete(id: string): Promise<boolean>;
}

/** Append-only security audit trail (spec §9: rows are never updated/deleted). */
export interface AuditLog {
  append(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): Promise<AuditLogEntry>;
  list(filter?: { eventType?: string; limit?: number }): Promise<AuditLogEntry[]>;
}

/** Replay-nonce cache for the webhook gateway (spec §9 webhook_replay_nonces). */
export interface NonceCache {
  /** Returns true when the key is fresh (and records it); false on replay. */
  checkAndAdd(key: string, ttlMs: number): Promise<boolean>;
}

/**
 * Process-wide kill-switch state (spec §8: "Freeze Platform").
 * Async because the durable implementation reads/writes Postgres; the
 * in-memory implementation below keeps the same contract for tests and
 * for runs without a database.
 */
export interface PlatformState {
  halt(): Promise<void>;
  resume(): Promise<void>;
  isHalted(): Promise<boolean>;
}

/** In-memory PlatformState (tests + DATABASE_URL-less runs). */
export class MemoryPlatformState implements PlatformState {
  private haltedFlag = false;
  async halt(): Promise<void> {
    this.haltedFlag = true;
  }
  async resume(): Promise<void> {
    this.haltedFlag = false;
  }
  async isHalted(): Promise<boolean> {
    return this.haltedFlag;
  }
}

export interface Stores {
  users: UsersRepository;
  sessions: SessionsRepository;
  credentials: CredentialsRepository;
  workflows: WorkflowsRepository;
  executions: ExecutionsRepository;
  webhooks: WebhooksRepository;
  audit: AuditLog;
  nonces: NonceCache;
  platform: PlatformState;
}

// ---------------------------------------------------------------------------
// In-memory implementations
// ---------------------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();

export class MemoryUsersRepository implements UsersRepository {
  private readonly byId = new Map<string, UserRecord>();

  async create(input: Omit<UserRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<UserRecord> {
    const ts = nowIso();
    const record: UserRecord = { ...input, email: input.email.toLowerCase(), id: randomUUID(), createdAt: ts, updatedAt: ts };
    this.byId.set(record.id, record);
    return record;
  }
  async findById(id: string): Promise<UserRecord | undefined> {
    return this.byId.get(id);
  }
  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const needle = email.toLowerCase();
    for (const user of this.byId.values()) if (user.email === needle) return user;
    return undefined;
  }
  async findOwner(): Promise<UserRecord | undefined> {
    for (const user of this.byId.values()) if (user.role === 'owner') return user;
    return undefined;
  }
  async update(id: string, patch: Partial<UserRecord>): Promise<UserRecord | undefined> {
    const current = this.byId.get(id);
    if (!current) return undefined;
    const next: UserRecord = { ...current, ...patch, id: current.id, updatedAt: nowIso() };
    this.byId.set(id, next);
    return next;
  }
}

export class MemorySessionsRepository implements SessionsRepository {
  private readonly byId = new Map<string, SessionRecord>();

  async create(input: Omit<SessionRecord, 'id' | 'createdAt'>): Promise<SessionRecord> {
    const record: SessionRecord = { ...input, id: randomUUID(), createdAt: nowIso() };
    this.byId.set(record.id, record);
    return record;
  }
  async findByTokenHash(tokenHash: string): Promise<SessionRecord | undefined> {
    for (const session of this.byId.values()) if (session.tokenHash === tokenHash) return session;
    return undefined;
  }
  async listByUser(userId: string): Promise<SessionRecord[]> {
    return [...this.byId.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async revoke(id: string): Promise<boolean> {
    const session = this.byId.get(id);
    if (!session || session.revokedAt) return false;
    this.byId.set(id, { ...session, revokedAt: nowIso() });
    return true;
  }
}

export class MemoryCredentialsRepository implements CredentialsRepository {
  private readonly byId = new Map<string, CredentialRecord>();

  async create(input: Omit<CredentialRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<CredentialRecord> {
    const ts = nowIso();
    const record: CredentialRecord = { ...input, id: randomUUID(), createdAt: ts, updatedAt: ts };
    this.byId.set(record.id, record);
    return record;
  }
  async findById(id: string): Promise<CredentialRecord | undefined> {
    return this.byId.get(id);
  }
  async listByUser(userId: string): Promise<CredentialRecord[]> {
    return [...this.byId.values()].filter((c) => c.userId === userId);
  }
  async findByName(userId: string, name: string): Promise<CredentialRecord | undefined> {
    for (const cred of this.byId.values()) {
      if (cred.userId === userId && cred.name === name) return cred;
    }
    return undefined;
  }
  async delete(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }
}

export class MemoryWorkflowsRepository implements WorkflowsRepository {
  private readonly byId = new Map<string, WorkflowRecord>();
  private readonly versions = new Map<string, WorkflowVersionRecord[]>();

  async create(input: Omit<WorkflowRecord, 'id' | 'createdAt' | 'updatedAt' | 'currentVersion'>): Promise<WorkflowRecord> {
    const ts = nowIso();
    const record: WorkflowRecord = { ...input, id: randomUUID(), currentVersion: 1, createdAt: ts, updatedAt: ts };
    this.byId.set(record.id, record);
    this.versions.set(record.id, [
      {
        id: randomUUID(),
        workflowId: record.id,
        version: 1,
        nodes: record.nodes,
        edges: record.edges,
        settings: record.settings,
        createdBy: record.userId,
        createdAt: ts,
      },
    ]);
    return record;
  }
  async findById(id: string): Promise<WorkflowRecord | undefined> {
    return this.byId.get(id);
  }
  async listByUser(userId: string): Promise<WorkflowRecord[]> {
    return [...this.byId.values()].filter((w) => w.userId === userId);
  }
  async updateMeta(
    id: string,
    patch: Partial<Pick<WorkflowRecord, 'name' | 'description' | 'tags'>>,
  ): Promise<WorkflowRecord | undefined> {
    const current = this.byId.get(id);
    if (!current) return undefined;
    const next: WorkflowRecord = { ...current, ...patch, updatedAt: nowIso() };
    this.byId.set(id, next);
    return next;
  }
  async saveVersion(
    id: string,
    graph: { nodes: WorkflowNodeInstance[]; edges: WorkflowEdge[]; settings: WorkflowSettings },
    comment: string | undefined,
    createdBy: string | undefined,
  ): Promise<WorkflowRecord | undefined> {
    const current = this.byId.get(id);
    if (!current) return undefined;
    const version = current.currentVersion + 1;
    const next: WorkflowRecord = { ...current, ...graph, currentVersion: version, updatedAt: nowIso() };
    this.byId.set(id, next);
    const rows = this.versions.get(id) ?? [];
    rows.push({
      id: randomUUID(),
      workflowId: id,
      version,
      nodes: graph.nodes,
      edges: graph.edges,
      settings: graph.settings,
      comment,
      createdBy,
      createdAt: nowIso(),
    });
    this.versions.set(id, rows);
    return next;
  }
  async setActive(id: string, isActive: boolean): Promise<WorkflowRecord | undefined> {
    const current = this.byId.get(id);
    if (!current) return undefined;
    const next: WorkflowRecord = { ...current, isActive, updatedAt: nowIso() };
    this.byId.set(id, next);
    return next;
  }
  async delete(id: string): Promise<boolean> {
    this.versions.delete(id);
    return this.byId.delete(id);
  }
  async listVersions(workflowId: string): Promise<WorkflowVersionRecord[]> {
    return [...(this.versions.get(workflowId) ?? [])].sort((a, b) => a.version - b.version);
  }
  async getVersion(workflowId: string, version: number): Promise<WorkflowVersionRecord | undefined> {
    return (this.versions.get(workflowId) ?? []).find((v) => v.version === version);
  }
}

export class MemoryExecutionsRepository implements ExecutionsRepository {
  private readonly byId = new Map<string, StoredExecution>();

  async add(execution: StoredExecution): Promise<void> {
    this.byId.set(execution.id, execution);
  }
  async findById(id: string): Promise<StoredExecution | undefined> {
    return this.byId.get(id);
  }
  async list(filter: { workflowId?: string; limit?: number } = {}): Promise<StoredExecution[]> {
    let rows = [...this.byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (filter.workflowId) rows = rows.filter((r) => r.workflowId === filter.workflowId);
    if (filter.limit !== undefined) rows = rows.slice(0, filter.limit);
    return rows;
  }
}

export class MemoryWebhooksRepository implements WebhooksRepository {
  private readonly byId = new Map<string, WebhookRecord>();

  async create(input: Omit<WebhookRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<WebhookRecord> {
    const ts = nowIso();
    const record: WebhookRecord = { ...input, id: randomUUID(), createdAt: ts, updatedAt: ts };
    this.byId.set(record.id, record);
    return record;
  }
  async findById(id: string): Promise<WebhookRecord | undefined> {
    return this.byId.get(id);
  }
  async findBySlug(slug: string): Promise<WebhookRecord | undefined> {
    for (const hook of this.byId.values()) if (hook.slug === slug) return hook;
    return undefined;
  }
  async list(): Promise<WebhookRecord[]> {
    return [...this.byId.values()];
  }
  async update(id: string, patch: Partial<WebhookRecord>): Promise<WebhookRecord | undefined> {
    const current = this.byId.get(id);
    if (!current) return undefined;
    const next: WebhookRecord = { ...current, ...patch, id: current.id, updatedAt: nowIso() };
    this.byId.set(id, next);
    return next;
  }
  async delete(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }
}

export class MemoryAuditLog implements AuditLog {
  private readonly entries: AuditLogEntry[] = [];

  async append(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): Promise<AuditLogEntry> {
    const full: AuditLogEntry = { ...entry, id: randomUUID(), createdAt: nowIso() };
    this.entries.push(full);
    return full;
  }
  async list(filter: { eventType?: string; limit?: number } = {}): Promise<AuditLogEntry[]> {
    let rows = [...this.entries].reverse();
    if (filter.eventType) rows = rows.filter((r) => r.eventType === filter.eventType);
    if (filter.limit !== undefined) rows = rows.slice(0, filter.limit);
    return rows;
  }
}

export class MemoryNonceCache implements NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async checkAndAdd(key: string, ttlMs: number): Promise<boolean> {
    const t = this.now();
    const expiresAt = this.seen.get(key);
    if (expiresAt !== undefined && expiresAt > t) return false;
    this.seen.set(key, t + ttlMs);
    if (this.seen.size > 10_000) {
      for (const [k, e] of this.seen) if (e <= t) this.seen.delete(k);
    }
    return true;
  }
}

/** A full set of in-memory stores (local runs + tests). */
export function createMemoryStores(): Stores {
  return {
    users: new MemoryUsersRepository(),
    sessions: new MemorySessionsRepository(),
    credentials: new MemoryCredentialsRepository(),
    workflows: new MemoryWorkflowsRepository(),
    executions: new MemoryExecutionsRepository(),
    webhooks: new MemoryWebhooksRepository(),
    audit: new MemoryAuditLog(),
    nonces: new MemoryNonceCache(),
    platform: new MemoryPlatformState(),
  };
}
