/** Types mirroring the apps/api (Fastify) response shapes exactly. */

export interface PublicUser {
  id: string;
  email: string;
  displayName?: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  locale: string;
  totpEnabled: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

/** One node placed on a workflow canvas (engine WorkflowNodeInstance). */
export interface WorkflowNodeInstance {
  id: string;
  /** Node type id, e.g. `core.if`, `whatsapp.sendMessage`. */
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
  disabled?: boolean;
  onError?: 'stop' | 'continue';
  /**
   * Canvas position. The engine ignores unknown node fields, and the API
   * stores the node objects verbatim, so the dashboard persists layout here.
   */
  position?: { x: number; y: number };
}

/** A connection from one node's output branch to another node's input. */
export interface WorkflowEdge {
  from: string;
  /** Output branch index of the source node. Default 0. */
  output?: number;
  to: string;
  input?: number;
}

export interface WorkflowSettings {
  timezone?: string;
  onError?: 'stop' | 'continue';
  variables?: Record<string, unknown>;
}

export interface Workflow {
  id: string;
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

export interface WorkflowVersion {
  version: number;
  nodes: WorkflowNodeInstance[];
  edges: WorkflowEdge[];
  settings: WorkflowSettings;
  comment?: string;
  createdBy?: string;
  createdAt: string;
}

export type ExecutionStepStatus = 'success' | 'error' | 'skipped';

export interface ExecutionStep {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: ExecutionStepStatus;
  startedAt: string;
  durationMs: number;
  attempts: number;
  input: unknown;
  output: unknown;
  error?: string;
}

export type ExecutionStatus = 'success' | 'error' | 'partial';

export interface Execution {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: ExecutionStep[];
  error?: string;
  triggerType: 'manual' | 'webhook' | 'cron' | 'polling' | 'retry';
  workflowVersion?: number;
}

export interface CredentialMeta {
  id: string;
  name: string;
  provider: string;
  kind: 'api_key' | 'oauth' | 'basic' | 'custom';
  createdAt: string;
  updatedAt: string;
}

export interface SessionInfo {
  id: string;
  deviceName?: string;
  userAgent?: string;
  ipAddress?: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  expired: boolean;
  current: boolean;
}

export interface AuditLogEntry {
  id: string;
  userId?: string;
  eventType: string;
  severity: 'info' | 'warning' | 'critical';
  ipAddress?: string;
  userAgent?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface HealthFactor {
  key: string;
  label: string;
  passed: boolean;
  weight: number;
}

export interface HealthScore {
  score: number;
  maxScore: number;
  factors: HealthFactor[];
  halted: boolean;
  computedAt: string;
}

export interface WebhookMeta {
  id: string;
  slug: string;
  workflowId: string;
  ipAllowlist: string[];
  isActive: boolean;
  lastTriggeredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SetupStatus {
  setupRequired: boolean;
  setupClosed: boolean;
}

export interface ClaimResult {
  user: PublicUser;
  token: string;
  totpSecret?: string;
  otpauthUri?: string;
}

export interface LoginResult {
  token: string;
  user: PublicUser;
}
