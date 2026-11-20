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

// -- unified inbox (spec §7.1) ------------------------------------------------

export interface ApiConversation {
  id: string;
  channel: 'whatsapp' | 'instagram';
  /** Buyer identity on the channel (phone number / IG user id). */
  externalId: string;
  displayName?: string;
  customerId?: string;
  aiPaused: boolean;
  pausedUntil?: string;
  messageCount: number;
  lastMessage?: {
    body: string;
    sender: 'customer' | 'ai' | 'human';
    direction: 'in' | 'out';
    createdAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ApiInboxMessage {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  sender: 'customer' | 'ai' | 'human';
  body: string;
  createdAt: string;
}

// -- master SKU catalog (spec §7.2) --------------------------------------------

export type CatalogChannel = 'shopify' | 'daraz' | 'local';

export interface ApiSkuMapping {
  id: string;
  masterSku: string;
  shopifySku?: string;
  shopifyProductId?: string;
  darazSku?: string;
  darazItemId?: string;
  localSku?: string;
  localProductId?: string;
  /** Channel-specific price overrides. */
  prices: Partial<Record<CatalogChannel, number>>;
  /** Units currently listed per channel. */
  stock: Record<CatalogChannel, number>;
  createdAt: string;
  updatedAt: string;
}

export interface SkuMappingInput {
  masterSku: string;
  shopifySku?: string;
  shopifyProductId?: string;
  darazSku?: string;
  darazItemId?: string;
  localSku?: string;
  localProductId?: string;
  prices?: Partial<Record<CatalogChannel, number>>;
  stock?: Partial<Record<CatalogChannel, number>>;
}

export interface SyncSaleResult {
  masterSku: string;
  channel: CatalogChannel;
  channelSku: string;
  qty: number;
  source: {
    channel: CatalogChannel;
    channelSku: string;
    deductQty: number;
    stockBefore: number;
    stockAfter: number;
    clamped: boolean;
  };
  plan: Array<{
    channel: CatalogChannel;
    channelSku?: string;
    masterSku: string;
    deductQty: number;
    stockBefore: number;
    stockAfter: number;
    clamped: boolean;
  }>;
  stock: Record<CatalogChannel, number>;
}
