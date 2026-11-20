import type {
  ApiConversation,
  ApiInboxMessage,
  ApiSkuMapping,
  AuditLogEntry,
  ClaimResult,
  CredentialMeta,
  Execution,
  HealthScore,
  LoginResult,
  PublicUser,
  SessionInfo,
  SetupStatus,
  SkuMappingInput,
  SyncSaleResult,
  WebhookMeta,
  Workflow,
  WorkflowEdge,
  WorkflowNodeInstance,
  WorkflowSettings,
  WorkflowVersion,
} from './types';

const TOKEN_KEY = 'cb.session.token';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly totpRequired: boolean;

  constructor(status: number, code: string, message?: string, totpRequired = false) {
    super(message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.totpRequired = totpRequired;
  }
}

export function getStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (tests / privacy mode) — session is in-memory only */
  }
}

type FetchFn = typeof fetch;

export class ApiClient {
  private token: string | null;
  private readonly fetchFn: FetchFn;

  constructor(fetchFn: FetchFn = (...args) => fetch(...args)) {
    this.fetchFn = fetchFn;
    this.token = getStoredToken();
  }

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  setToken(token: string | null): void {
    this.token = token;
    storeToken(token);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    const res = await this.fetchFn(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = (data ?? {}) as { error?: string; message?: string; totpRequired?: boolean };
      throw new ApiError(
        res.status,
        err.error ?? 'request_failed',
        err.message,
        Boolean(err.totpRequired) || err.error === 'totp_required',
      );
    }
    return data as T;
  }

  // -- setup ---------------------------------------------------------------
  setupStatus(): Promise<SetupStatus> {
    return this.request('GET', '/api/setup/status');
  }

  claim(input: {
    setupToken: string;
    email: string;
    password: string;
    displayName?: string;
    enableTotp?: boolean;
  }): Promise<ClaimResult> {
    return this.request('POST', '/api/setup/claim', input);
  }

  // -- auth ------------------------------------------------------------------
  async login(email: string, password: string, totpCode?: string): Promise<LoginResult> {
    const result = await this.request<LoginResult>('POST', '/api/auth/login', {
      email,
      password,
      ...(totpCode ? { totpCode } : {}),
    });
    this.setToken(result.token);
    return result;
  }

  async logout(): Promise<void> {
    try {
      await this.request('POST', '/api/auth/logout');
    } finally {
      this.setToken(null);
    }
  }

  async me(): Promise<PublicUser> {
    const res = await this.request<{ user: PublicUser }>('GET', '/api/auth/me');
    return res.user;
  }

  async listSessions(): Promise<SessionInfo[]> {
    const res = await this.request<{ sessions: SessionInfo[] }>('GET', '/api/auth/sessions');
    return res.sessions;
  }

  revokeSession(id: string): Promise<void> {
    return this.request('DELETE', `/api/auth/sessions/${encodeURIComponent(id)}`);
  }

  totpEnrol(): Promise<{ secret: string; otpauthUri: string }> {
    return this.request('POST', '/api/auth/totp/enrol', {});
  }

  totpConfirm(code: string): Promise<{ totpEnabled: boolean }> {
    return this.request('POST', '/api/auth/totp/confirm', { code });
  }

  totpDisable(code: string): Promise<{ totpEnabled: boolean }> {
    return this.request('POST', '/api/auth/totp/disable', { code });
  }

  // -- credentials vault (write-only) -----------------------------------------
  async listCredentials(): Promise<CredentialMeta[]> {
    const res = await this.request<{ items: CredentialMeta[] }>('GET', '/api/credentials');
    return res.items;
  }

  createCredential(input: {
    name: string;
    provider: string;
    kind?: CredentialMeta['kind'];
    value: string;
  }): Promise<CredentialMeta> {
    return this.request('POST', '/api/credentials', input);
  }

  deleteCredential(id: string): Promise<void> {
    return this.request('DELETE', `/api/credentials/${encodeURIComponent(id)}`);
  }

  // -- workflows ----------------------------------------------------------------
  async listWorkflows(): Promise<Workflow[]> {
    const res = await this.request<{ workflows: Workflow[] }>('GET', '/api/workflows');
    return res.workflows;
  }

  getWorkflow(id: string): Promise<Workflow> {
    return this.request('GET', `/api/workflows/${encodeURIComponent(id)}`);
  }

  createWorkflow(input: {
    name: string;
    description?: string;
    nodes: WorkflowNodeInstance[];
    edges: WorkflowEdge[];
    settings?: WorkflowSettings;
    tags?: string[];
  }): Promise<Workflow> {
    return this.request('POST', '/api/workflows', input);
  }

  updateWorkflow(
    id: string,
    input: {
      name?: string;
      description?: string;
      tags?: string[];
      nodes?: WorkflowNodeInstance[];
      edges?: WorkflowEdge[];
      settings?: WorkflowSettings;
      comment?: string;
    },
  ): Promise<Workflow> {
    return this.request('PUT', `/api/workflows/${encodeURIComponent(id)}`, input);
  }

  deleteWorkflow(id: string): Promise<void> {
    return this.request('DELETE', `/api/workflows/${encodeURIComponent(id)}`);
  }

  setWorkflowActive(id: string, active: boolean): Promise<Workflow> {
    return this.request('POST', `/api/workflows/${encodeURIComponent(id)}/${active ? 'activate' : 'deactivate'}`, {});
  }

  async listWorkflowVersions(id: string): Promise<WorkflowVersion[]> {
    const res = await this.request<{ versions: WorkflowVersion[] }>(
      'GET',
      `/api/workflows/${encodeURIComponent(id)}/versions`,
    );
    return res.versions;
  }

  runWorkflow(id: string, input?: { triggerData?: unknown; variables?: Record<string, unknown> }): Promise<Execution> {
    return this.request('POST', `/api/workflows/${encodeURIComponent(id)}/run`, input ?? {});
  }

  // -- executions ---------------------------------------------------------------
  async listExecutions(filter?: { workflowId?: string; limit?: number }): Promise<Execution[]> {
    const params = new URLSearchParams();
    if (filter?.workflowId) params.set('workflowId', filter.workflowId);
    if (filter?.limit) params.set('limit', String(filter.limit));
    const qs = params.toString();
    const res = await this.request<{ executions: Execution[] }>('GET', `/api/executions${qs ? `?${qs}` : ''}`);
    return res.executions;
  }

  getExecution(id: string): Promise<Execution> {
    return this.request('GET', `/api/executions/${encodeURIComponent(id)}`);
  }

  // -- webhooks (admin) -----------------------------------------------------------
  async listWebhooks(): Promise<WebhookMeta[]> {
    const res = await this.request<{ webhooks: WebhookMeta[] }>('GET', '/api/webhooks');
    return res.webhooks;
  }

  createWebhook(input: {
    workflowId: string;
    slug?: string;
    ipAllowlist?: string[];
  }): Promise<WebhookMeta & { hmacSecret: string }> {
    return this.request('POST', '/api/webhooks', input);
  }

  deleteWebhook(id: string): Promise<void> {
    return this.request('DELETE', `/api/webhooks/${encodeURIComponent(id)}`);
  }

  // -- security center --------------------------------------------------------------
  async listAuditLogs(filter?: { eventType?: string; limit?: number }): Promise<AuditLogEntry[]> {
    const params = new URLSearchParams();
    if (filter?.eventType) params.set('eventType', filter.eventType);
    if (filter?.limit) params.set('limit', String(filter.limit));
    const qs = params.toString();
    const res = await this.request<{ logs: AuditLogEntry[] }>(
      'GET',
      `/api/security/audit-logs${qs ? `?${qs}` : ''}`,
    );
    return res.logs;
  }

  healthScore(): Promise<HealthScore> {
    return this.request('GET', '/api/security/health-score');
  }

  killSwitch(): Promise<{ halted: boolean }> {
    return this.request('POST', '/api/security/kill-switch', {});
  }

  resumePlatform(): Promise<{ halted: boolean }> {
    return this.request('POST', '/api/security/resume', {});
  }

  // -- unified inbox (spec §7.1) --------------------------------------------------
  async listInboxConversations(): Promise<ApiConversation[]> {
    const res = await this.request<{ conversations: ApiConversation[] }>(
      'GET',
      '/api/inbox/conversations',
    );
    return res.conversations;
  }

  async listInboxMessages(
    conversationId: string,
  ): Promise<{ conversation: ApiConversation; messages: ApiInboxMessage[] }> {
    return this.request(
      'GET',
      `/api/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
  }

  /** Human reply — the API auto-pauses the AI for the takeover window. */
  async replyToConversation(
    conversationId: string,
    body: string,
  ): Promise<{ message: ApiInboxMessage; conversation: ApiConversation }> {
    return this.request(
      'POST',
      `/api/inbox/conversations/${encodeURIComponent(conversationId)}/reply`,
      { body },
    );
  }

  /** Human takeover toggle: paused=true pauses the AI, false hands it back. */
  async setConversationTakeover(
    conversationId: string,
    paused: boolean,
    windowMinutes?: number,
  ): Promise<ApiConversation> {
    const res = await this.request<{ conversation: ApiConversation }>(
      'POST',
      `/api/inbox/conversations/${encodeURIComponent(conversationId)}/takeover`,
      { paused, ...(windowMinutes !== undefined ? { windowMinutes } : {}) },
    );
    return res.conversation;
  }

  // -- master SKU catalog (spec §7.2) ----------------------------------------------
  async listSkuMappings(): Promise<ApiSkuMapping[]> {
    const res = await this.request<{ mappings: ApiSkuMapping[] }>(
      'GET',
      '/api/catalog/sku-mappings',
    );
    return res.mappings;
  }

  createSkuMapping(input: SkuMappingInput): Promise<ApiSkuMapping> {
    return this.request('POST', '/api/catalog/sku-mappings', input);
  }

  updateSkuMapping(id: string, input: Partial<SkuMappingInput>): Promise<ApiSkuMapping> {
    return this.request('PUT', `/api/catalog/sku-mappings/${encodeURIComponent(id)}`, input);
  }

  deleteSkuMapping(id: string): Promise<void> {
    return this.request('DELETE', `/api/catalog/sku-mappings/${encodeURIComponent(id)}`);
  }

  syncCatalogSale(input: {
    channel: 'shopify' | 'daraz' | 'local';
    channelSku: string;
    qty: number;
  }): Promise<SyncSaleResult> {
    return this.request('POST', '/api/catalog/sync-sale', input);
  }
}

/** Shared singleton used by the app; tests construct their own with a mock fetch. */
export const api = new ApiClient();
