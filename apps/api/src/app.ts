/**
 * @code-brothers/api — Fastify 5 REST server for Code Brothers (spec §3, §5,
 * §7, §8; build guide §11 Steps 3–4).
 *
 * Surface:
 *  - First-boot setup: one-time setup token claims the owner account, then
 *    setup closes permanently.
 *  - Auth: Argon2id password login behind the LoginThrottle, optional TOTP
 *    second factor, opaque session tokens hashed at rest.
 *  - Credentials vault: write-only — values go in through the AES-256-GCM
 *    envelope vault and never come back out; reads return metadata only.
 *  - Workflows: CRUD + version history, executed through @code-brothers/core.
 *  - Webhook gateway: HMAC-SHA256 verified, replay-protected, IP-allowlisted.
 *  - Security center: append-only audit log, computed health score, and the
 *    owner-only kill switch that freezes runs and webhook triggers.
 *
 * Redaction policy (spec §8C): every JSON response passes through the secret
 * redactor on the way out, EXCEPT the four one-time-disclosure responses
 * whose entire purpose is to hand a secret to its owner exactly once
 * (login session token, setup claim, TOTP enrolment secret, webhook HMAC
 * secret at creation). Stored data (execution records, audit details) is
 * redacted before it is stored as well.
 */
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  LoginThrottle,
  SetupTokenService,
  decryptSecret,
  encryptSecret,
  generateMasterKey,
  generateTotpSecret,
  hashPassword,
  parseMasterKey,
  redact,
  redactString,
  verifyPassword,
  verifyTotp,
  type EncryptedSecret,
} from '@code-brothers/security';
import {
  createEngine,
  type WorkflowDefinition,
} from '@code-brothers/core';
import {
  createMemoryStores,
  type CredentialRecord,
  type SessionRecord,
  type Stores,
  type StoredExecution,
  type TriggerType,
  type UserRecord,
  type WorkflowRecord,
} from './store.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: UserRecord;
    authSession?: SessionRecord;
  }
}

export interface ApiOptions {
  /** Vault master key. Defaults to CB_MASTER_KEY env, else an ephemeral key. */
  masterKey?: Buffer;
  /** Whether the master key counts as "configured" for the health score. */
  masterKeyConfigured?: boolean;
  setupTokenService?: SetupTokenService;
  throttle?: LoginThrottle;
  /** Session lifetime in ms. Default 24h. */
  sessionTtlMs?: number;
  /** Webhook nonce TTL in ms. Default 10 minutes. */
  nonceTtlMs?: number;
  /** Max accepted webhook timestamp skew in ms. Default 5 minutes (spec §8). */
  webhookTimestampToleranceMs?: number;
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
  /** Pre-built stores (defaults to in-memory). */
  stores?: Stores;
  logger?: boolean;
}

export interface BuiltApi {
  app: FastifyInstance;
  stores: Stores;
  setupTokenService: SetupTokenService;
  /** The one-time setup token, present only while setup is still pending. */
  setupToken?: string;
  masterKeyConfigured: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Responses allowed to carry a one-time-disclosed secret to its owner. */
const DISCLOSURE_ROUTES = new Set([
  'POST /api/auth/login',
  'POST /api/setup/claim',
  'POST /api/auth/totp/enrol',
  'POST /api/webhooks',
]);

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function otpauthUri(secret: string, email: string): string {
  return `otpauth://totp/CodeBrothers:${encodeURIComponent(email)}?secret=${secret}&issuer=CodeBrothers`;
}

function publicUser(user: UserRecord): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    locale: user.locale,
    totpEnabled: user.totpEnabled,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/** Exact-IP or IPv4-CIDR membership test (IPv6-mapped IPv4 normalized). */
function ipMatches(ip: string, rule: string): boolean {
  const addr = ip.replace(/^::ffff:/, '');
  const target = rule.trim().replace(/^::ffff:/, '');
  if (!target.includes('/')) return addr === target;
  const [base, bitsText] = target.split('/');
  const bits = Number(bitsText);
  const toInt = (value: string): number | undefined => {
    const parts = value.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return undefined;
    return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0) as number;
  };
  const ipInt = toInt(addr);
  const baseInt = toInt(base);
  if (ipInt === undefined || baseInt === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

export async function buildApp(options: ApiOptions = {}): Promise<BuiltApi> {
  const now = options.now ?? Date.now;
  const stores = options.stores ?? createMemoryStores();
  const throttle = options.throttle ?? new LoginThrottle();
  const setupTokenService = options.setupTokenService ?? new SetupTokenService();
  const sessionTtlMs = options.sessionTtlMs ?? 24 * 60 * 60 * 1000;
  const nonceTtlMs = options.nonceTtlMs ?? 10 * 60 * 1000;
  const timestampToleranceMs = options.webhookTimestampToleranceMs ?? 5 * 60 * 1000;

  let masterKey: Buffer;
  let masterKeyConfigured: boolean;
  if (options.masterKey) {
    masterKey = options.masterKey;
    masterKeyConfigured = options.masterKeyConfigured ?? true;
  } else if (process.env.CB_MASTER_KEY) {
    masterKey = parseMasterKey(process.env.CB_MASTER_KEY);
    masterKeyConfigured = options.masterKeyConfigured ?? true;
  } else {
    masterKey = parseMasterKey(generateMasterKey());
    masterKeyConfigured = options.masterKeyConfigured ?? false;
  }

  const safeDecrypt = (record: EncryptedSecret): string | undefined => {
    try {
      return decryptSecret(record, masterKey);
    } catch {
      return undefined;
    }
  };

  const app = Fastify({ logger: options.logger ?? false });

  // -- redaction on the way out (see the policy note at the top of the file)
  app.addHook('onSend', async (req, _reply, payload) => {
    if (typeof payload !== 'string' || payload.length === 0) return payload;
    const routeKey = `${req.method} ${req.url.split('?')[0]}`;
    if (DISCLOSURE_ROUTES.has(routeKey)) return payload;
    try {
      const parsed: unknown = JSON.parse(payload);
      return JSON.stringify(redact(parsed));
    } catch {
      return payload;
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    const status = typeof statusCode === 'number' ? statusCode : 500;
    const message = err instanceof Error ? err.message : 'Internal error';
    void reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'request_error',
      message: redactString(message),
    });
  });

  // -- shared helpers -------------------------------------------------------

  async function audit(
    req: FastifyRequest | undefined,
    entry: {
      userId?: string;
      eventType: string;
      severity?: 'info' | 'warning' | 'critical';
      details?: Record<string, unknown>;
    },
  ): Promise<void> {
    await stores.audit.append({
      userId: entry.userId,
      eventType: entry.eventType,
      severity: entry.severity ?? 'info',
      ipAddress: req?.ip,
      userAgent: req ? header(req, 'user-agent') : undefined,
      details: redact(entry.details ?? {}),
    });
  }

  async function issueSession(user: UserRecord, req: FastifyRequest): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await stores.sessions.create({
      userId: user.id,
      tokenHash: sha256Hex(token),
      userAgent: header(req, 'user-agent'),
      ipAddress: req.ip,
      expiresAt: new Date(now() + sessionTtlMs).toISOString(),
    });
    return token;
  }

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = header(req, 'authorization');
    const match = auth ? /^Bearer\s+(.+)$/i.exec(auth) : null;
    if (!match) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const session = await stores.sessions.findByTokenHash(sha256Hex(match[1].trim()));
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= now()) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const user = await stores.users.findById(session.userId);
    if (!user || !user.isActive) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    req.authUser = user;
    req.authSession = session;
  };

  const requireOwner = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (req.authUser?.role !== 'owner') {
      await reply.code(403).send({ error: 'owner_required' });
    }
  };

  async function executeWorkflow(
    workflow: WorkflowRecord,
    run: {
      triggerType: TriggerType;
      triggerData?: unknown;
      variables?: Record<string, unknown>;
      triggerNodeId?: string;
    },
  ): Promise<StoredExecution> {
    const engine = createEngine({
      redactor: (value) => redact(value),
      credentialsProvider: async (name) => {
        const cred = await stores.credentials.findByName(workflow.userId, name);
        if (!cred) return undefined;
        const plain = safeDecrypt(cred.encrypted);
        if (plain === undefined) return undefined;
        try {
          const parsed: unknown = JSON.parse(plain);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
          return { value: parsed };
        } catch {
          return { value: plain };
        }
      },
    });
    const definition: WorkflowDefinition = {
      id: workflow.id,
      name: workflow.name,
      nodes: workflow.nodes,
      edges: workflow.edges,
      settings: workflow.settings,
    };
    const record = await engine.execute(definition, {
      triggerData: run.triggerData,
      variables: run.variables,
      triggerNodeId: run.triggerNodeId,
    });
    const stored: StoredExecution = {
      ...record,
      triggerType: run.triggerType,
      workflowVersion: workflow.currentVersion,
    };
    await stores.executions.add(stored);
    return stored;
  }

  // -- setup (first boot) ---------------------------------------------------

  app.get('/api/setup/status', async () => {
    const owner = await stores.users.findOwner();
    return { setupRequired: !owner, setupClosed: Boolean(owner) };
  });

  app.post('/api/setup/claim', async (req, reply) => {
    const owner = await stores.users.findOwner();
    if (owner) return reply.code(403).send({ error: 'setup_closed' });

    const body = (req.body ?? {}) as {
      setupToken?: unknown;
      email?: unknown;
      password?: unknown;
      displayName?: unknown;
      enableTotp?: unknown;
    };
    const email = typeof body.email === 'string' ? body.email.toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!EMAIL_RE.test(email)) {
      return reply.code(400).send({ error: 'validation_error', message: 'A valid email is required' });
    }
    if (password.length < 8) {
      return reply.code(400).send({ error: 'validation_error', message: 'Password must be at least 8 characters' });
    }
    if (typeof body.setupToken !== 'string' || !setupTokenService.verifySetupToken(body.setupToken)) {
      await audit(req, { eventType: 'setup_claim_failed', severity: 'warning', details: { email } });
      return reply.code(401).send({ error: 'invalid_setup_token' });
    }

    let totpSecretPlain: string | undefined;
    let totpSecretRecord: EncryptedSecret | undefined;
    if (body.enableTotp === true) {
      totpSecretPlain = generateTotpSecret();
      totpSecretRecord = encryptSecret(totpSecretPlain, masterKey);
    }

    const user = await stores.users.create({
      email,
      passwordHash: await hashPassword(password),
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      role: 'owner',
      locale: 'en',
      totpSecret: totpSecretRecord,
      totpEnabled: Boolean(totpSecretPlain),
      isActive: true,
    });
    const token = await issueSession(user, req);
    await audit(req, { userId: user.id, eventType: 'setup_claimed', severity: 'critical', details: { email } });

    const response: Record<string, unknown> = { user: publicUser(user), token };
    if (totpSecretPlain) {
      response.totpSecret = totpSecretPlain;
      response.otpauthUri = otpauthUri(totpSecretPlain, email);
    }
    return reply.code(201).send(response);
  });

  // -- auth -----------------------------------------------------------------

  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown; totpCode?: unknown };
    const email = typeof body.email === 'string' ? body.email.toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) {
      return reply.code(400).send({ error: 'validation_error', message: 'email and password are required' });
    }
    const throttleKey = `${req.ip}|${email}`;
    if (throttle.isLocked(throttleKey)) {
      const status = throttle.getStatus(throttleKey);
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: status.retryAfterMs });
    }

    const user = await stores.users.findByEmail(email);
    const passwordOk = user ? await verifyPassword(user.passwordHash, password) : false;
    if (!user || !passwordOk || !user.isActive) {
      throttle.recordFailure(throttleKey);
      await audit(req, { userId: user?.id, eventType: 'login_failed', severity: 'warning', details: { email } });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    if (user.totpEnabled) {
      const code = typeof body.totpCode === 'string' ? body.totpCode : '';
      if (!code) {
        return reply.code(401).send({ error: 'totp_required', totpRequired: true });
      }
      const secret = user.totpSecret ? safeDecrypt(user.totpSecret) : undefined;
      if (!secret || !verifyTotp(secret, code)) {
        throttle.recordFailure(throttleKey);
        await audit(req, { userId: user.id, eventType: '2fa_failed', severity: 'warning', details: { email } });
        return reply.code(401).send({ error: 'invalid_totp_code' });
      }
    }

    throttle.recordSuccess(throttleKey);
    const fresh = await stores.users.update(user.id, { lastLoginAt: new Date(now()).toISOString() });
    const token = await issueSession(user, req);
    await audit(req, { userId: user.id, eventType: 'login_success', details: { email } });
    return { token, user: publicUser(fresh ?? user) };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => ({
    user: publicUser(req.authUser as UserRecord),
  }));

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    await stores.sessions.revoke((req.authSession as SessionRecord).id);
    return reply.code(204).send();
  });

  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (req) => {
    const user = req.authUser as UserRecord;
    const sessions = await stores.sessions.listByUser(user.id);
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        deviceName: s.deviceName,
        userAgent: s.userAgent,
        ipAddress: s.ipAddress,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        revokedAt: s.revokedAt,
        expired: Date.parse(s.expiresAt) <= now(),
        current: s.id === (req.authSession as SessionRecord).id,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/auth/sessions/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = req.authUser as UserRecord;
      const sessions = await stores.sessions.listByUser(user.id);
      const target = sessions.find((s) => s.id === req.params.id);
      if (!target) return reply.code(404).send({ error: 'session_not_found' });
      await stores.sessions.revoke(target.id);
      await audit(req, { userId: user.id, eventType: 'session_revoked', details: { sessionId: target.id } });
      return reply.code(204).send();
    },
  );

  // -- TOTP management ------------------------------------------------------

  app.post('/api/auth/totp/enrol', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.authUser as UserRecord;
    if (user.totpEnabled) return reply.code(409).send({ error: 'totp_already_enabled' });
    const secret = generateTotpSecret();
    await stores.users.update(user.id, {
      totpSecret: encryptSecret(secret, masterKey),
      totpEnabled: false,
    });
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  });

  app.post('/api/auth/totp/confirm', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.authUser as UserRecord;
    const code = (req.body as { code?: unknown } | null)?.code;
    const secret = user.totpSecret ? safeDecrypt(user.totpSecret) : undefined;
    if (!secret) return reply.code(409).send({ error: 'totp_not_enrolled' });
    if (typeof code !== 'string' || !verifyTotp(secret, code)) {
      return reply.code(401).send({ error: 'invalid_totp_code' });
    }
    await stores.users.update(user.id, { totpEnabled: true });
    await audit(req, { userId: user.id, eventType: 'totp_enabled', details: {} });
    return { totpEnabled: true };
  });

  app.post('/api/auth/totp/disable', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.authUser as UserRecord;
    if (!user.totpEnabled) return reply.code(409).send({ error: 'totp_not_enabled' });
    const code = (req.body as { code?: unknown } | null)?.code;
    const secret = user.totpSecret ? safeDecrypt(user.totpSecret) : undefined;
    if (!secret || typeof code !== 'string' || !verifyTotp(secret, code)) {
      return reply.code(401).send({ error: 'invalid_totp_code' });
    }
    await stores.users.update(user.id, { totpEnabled: false, totpSecret: undefined });
    await audit(req, { userId: user.id, eventType: 'totp_disabled', severity: 'warning', details: {} });
    return { totpEnabled: false };
  });

  // -- credentials vault (write-only) ----------------------------------------

  const credentialMeta = (cred: CredentialRecord): Record<string, unknown> => ({
    id: cred.id,
    name: cred.name,
    provider: cred.provider,
    kind: cred.kind,
    createdAt: cred.createdAt,
    updatedAt: cred.updatedAt,
  });

  app.post('/api/credentials', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.authUser as UserRecord;
    const body = (req.body ?? {}) as {
      name?: unknown;
      provider?: unknown;
      kind?: unknown;
      value?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'validation_error', message: 'name is required' });
    const value = body.value;
    if (typeof value !== 'string' && !(value && typeof value === 'object')) {
      return reply.code(400).send({ error: 'validation_error', message: 'value (string or object) is required' });
    }
    if (await stores.credentials.findByName(user.id, name)) {
      return reply.code(409).send({ error: 'credential_exists' });
    }
    const kind =
      body.kind === 'oauth' || body.kind === 'basic' || body.kind === 'custom' ? body.kind : 'api_key';
    const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
    const cred = await stores.credentials.create({
      userId: user.id,
      provider: typeof body.provider === 'string' ? body.provider : 'custom',
      name,
      kind,
      encrypted: encryptSecret(plaintext, masterKey),
    });
    await audit(req, {
      userId: user.id,
      eventType: 'credential_created',
      details: { credentialId: cred.id, name: cred.name, provider: cred.provider },
    });
    return reply.code(201).send(credentialMeta(cred));
  });

  app.get('/api/credentials', { preHandler: requireAuth }, async (req) => {
    const user = req.authUser as UserRecord;
    const creds = await stores.credentials.listByUser(user.id);
    // Note: the wrapper key is `items`, not `credentials` — the secret
    // redactor (spec §8C) replaces any value stored under a key named
    // "credentials" wholesale, by design.
    return { items: creds.map(credentialMeta) };
  });

  app.get<{ Params: { id: string } }>(
    '/api/credentials/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = req.authUser as UserRecord;
      const cred = await stores.credentials.findById(req.params.id);
      if (!cred || cred.userId !== user.id) return reply.code(404).send({ error: 'credential_not_found' });
      return credentialMeta(cred);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/credentials/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = req.authUser as UserRecord;
      const cred = await stores.credentials.findById(req.params.id);
      if (!cred || cred.userId !== user.id) return reply.code(404).send({ error: 'credential_not_found' });
      await stores.credentials.delete(cred.id);
      await audit(req, {
        userId: user.id,
        eventType: 'credential_deleted',
        severity: 'warning',
        details: { credentialId: cred.id, name: cred.name },
      });
      return reply.code(204).send();
    },
  );

  // -- workflows --------------------------------------------------------------

  const workflowView = (w: WorkflowRecord): Record<string, unknown> => ({
    id: w.id,
    name: w.name,
    description: w.description,
    nodes: w.nodes,
    edges: w.edges,
    settings: w.settings,
    isActive: w.isActive,
    currentVersion: w.currentVersion,
    tags: w.tags,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  });

  async function findOwnedWorkflow(req: FastifyRequest, id: string): Promise<WorkflowRecord | undefined> {
    const workflow = await stores.workflows.findById(id);
    if (!workflow || workflow.userId !== (req.authUser as UserRecord).id) return undefined;
    return workflow;
  }

  app.post('/api/workflows', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.authUser as UserRecord;
    const body = (req.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      nodes?: unknown;
      edges?: unknown;
      settings?: unknown;
      tags?: unknown;
    };
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return reply.code(400).send({ error: 'validation_error', message: 'name is required' });
    }
    if (body.nodes !== undefined && !Array.isArray(body.nodes)) {
      return reply.code(400).send({ error: 'validation_error', message: 'nodes must be an array' });
    }
    if (body.edges !== undefined && !Array.isArray(body.edges)) {
      return reply.code(400).send({ error: 'validation_error', message: 'edges must be an array' });
    }
    const workflow = await stores.workflows.create({
      userId: user.id,
      name: body.name,
      description: typeof body.description === 'string' ? body.description : undefined,
      nodes: (body.nodes as WorkflowRecord['nodes']) ?? [],
      edges: (body.edges as WorkflowRecord['edges']) ?? [],
      settings: (body.settings as WorkflowRecord['settings']) ?? {},
      isActive: false,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
    });
    return reply.code(201).send(workflowView(workflow));
  });

  app.get('/api/workflows', { preHandler: requireAuth }, async (req) => {
    const user = req.authUser as UserRecord;
    const workflows = await stores.workflows.listByUser(user.id);
    return { workflows: workflows.map(workflowView) };
  });

  app.get<{ Params: { id: string } }>(
    '/api/workflows/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const workflow = await findOwnedWorkflow(req, req.params.id);
      if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' });
      return workflowView(workflow);
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/workflows/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = req.authUser as UserRecord;
      const workflow = await findOwnedWorkflow(req, req.params.id);
      if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' });
      const body = (req.body ?? {}) as {
        name?: unknown;
        description?: unknown;
        tags?: unknown;
        nodes?: unknown;
        edges?: unknown;
        settings?: unknown;
        comment?: unknown;
      };
      const hasGraph = body.nodes !== undefined || body.edges !== undefined || body.settings !== undefined;
      if (body.nodes !== undefined && !Array.isArray(body.nodes)) {
        return reply.code(400).send({ error: 'validation_error', message: 'nodes must be an array' });
      }
      if (body.edges !== undefined && !Array.isArray(body.edges)) {
        return reply.code(400).send({ error: 'validation_error', message: 'edges must be an array' });
      }
      let current = workflow;
      if (
        typeof body.name === 'string' ||
        typeof body.description === 'string' ||
        Array.isArray(body.tags)
      ) {
        const updated = await stores.workflows.updateMeta(workflow.id, {
          name: typeof body.name === 'string' ? body.name : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        });
        if (updated) current = updated;
      }
      if (hasGraph) {
        const updated = await stores.workflows.saveVersion(
          workflow.id,
          {
            nodes: (body.nodes as WorkflowRecord['nodes']) ?? current.nodes,
            edges: (body.edges as WorkflowRecord['edges']) ?? current.edges,
            settings: (body.settings as WorkflowRecord['settings']) ?? current.settings,
          },
          typeof body.comment === 'string' ? body.comment : undefined,
          user.id,
        );
        if (updated) current = updated;
      }
      return workflowView(current);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/workflows/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const workflow = await findOwnedWorkflow(req, req.params.id);
      if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' });
      await stores.workflows.delete(workflow.id);
      for (const hook of await stores.webhooks.list()) {
        if (hook.workflowId === workflow.id) await stores.webhooks.delete(hook.id);
      }
      return reply.code(204).send();
    },
  );

  for (const action of ['activate', 'deactivate'] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/workflows/:id/${action}`,
      { preHandler: requireAuth },
      async (req, reply) => {
        const workflow = await findOwnedWorkflow(req, req.params.id);
        if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' });
        const updated = await stores.workflows.setActive(workflow.id, action === 'activate');
        return workflowView(updated ?? workflow);
      },
    );
  }

  app.get<{ Params: { id: string } }>(
    '/api/workflows/:id/versions',
    { preHandler: requireAuth },
    async (req, reply) => {
      const workflow = await findOwnedWorkflow(req, req.params.id);
      if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' });
      const versions = await stores.workflows.listVersions(workflow.id);
      return {
        versions: versions.map((v) => ({
          version: v.version,
          nodes: v.nodes,
          edges: v.edges,
          settings: v.settings,
          comment: v.comment,
          createdBy: v.createdBy,
          createdAt: v.createdAt,
        })),
      };
    },
  );

  app.get<{ Params: { id: string; version: string } }>(
    '/api/workflows/:id/versions/:version',
    { preHandler: requireAuth },
    async (req, reply) => {
      const workflow = await findOwnedWorkflow(req, req.params.id);
      if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' });
      const version = await stores.workflows.getVersion(workflow.id, Number(req.params.version));
      if (!version) return reply.code(404).send({ error: 'version_not_found' });
      return {
        version: version.version,
        nodes: version.nodes,
        edges: version.edges,
        settings: version.settings,
        comment: version.comment,
        createdBy: version.createdBy,
        createdAt: version.createdAt,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/workflows/:id/run',
    { preHandler: requireAuth },
    async (req, reply) => {
      const workflow = await findOwnedWorkflow(req, req.params.id);
      if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' });
      if (stores.platform.isHalted()) {
        return reply.code(503).send({ error: 'platform_halted' });
      }
      const body = (req.body ?? {}) as { triggerData?: unknown; variables?: Record<string, unknown> };
      try {
        const execution = await executeWorkflow(workflow, {
          triggerType: 'manual',
          triggerData: body.triggerData,
          variables: body.variables,
        });
        return reply.code(201).send(execution);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Workflow execution failed';
        return reply.code(422).send({ error: 'workflow_invalid', message: redactString(message) });
      }
    },
  );

  // -- executions -------------------------------------------------------------

  app.get('/api/executions', { preHandler: requireAuth }, async (req) => {
    const query = req.query as { workflowId?: string; limit?: string };
    const limit = query.limit ? Math.min(Math.max(Number(query.limit) || 0, 1), 500) : 100;
    const executions = await stores.executions.list({ workflowId: query.workflowId, limit });
    return { executions };
  });

  app.get<{ Params: { id: string } }>(
    '/api/executions/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const execution = await stores.executions.findById(req.params.id);
      if (!execution) return reply.code(404).send({ error: 'execution_not_found' });
      return execution;
    },
  );

  // -- webhooks (admin) ---------------------------------------------------------

  const webhookMeta = (hook: {
    id: string;
    slug: string;
    workflowId: string;
    ipAllowlist: string[];
    isActive: boolean;
    lastTriggeredAt?: string;
    createdAt: string;
    updatedAt: string;
  }): Record<string, unknown> => ({
    id: hook.id,
    slug: hook.slug,
    workflowId: hook.workflowId,
    ipAllowlist: hook.ipAllowlist,
    isActive: hook.isActive,
    lastTriggeredAt: hook.lastTriggeredAt,
    createdAt: hook.createdAt,
    updatedAt: hook.updatedAt,
  });

  app.post('/api/webhooks', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { workflowId?: unknown; slug?: unknown; ipAllowlist?: unknown };
    if (typeof body.workflowId !== 'string') {
      return reply.code(400).send({ error: 'validation_error', message: 'workflowId is required' });
    }
    const workflow = await findOwnedWorkflow(req, body.workflowId);
    if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' });
    const slug =
      typeof body.slug === 'string' && body.slug.trim() !== ''
        ? body.slug.trim()
        : randomBytes(8).toString('hex');
    if (await stores.webhooks.findBySlug(slug)) {
      return reply.code(409).send({ error: 'slug_taken' });
    }
    const secret = randomBytes(32).toString('hex');
    const hook = await stores.webhooks.create({
      workflowId: workflow.id,
      slug,
      hmacSecretEncrypted: encryptSecret(secret, masterKey),
      ipAllowlist: Array.isArray(body.ipAllowlist) ? (body.ipAllowlist as string[]) : [],
      isActive: true,
    });
    // The HMAC secret is disclosed exactly once, at creation (like GitHub).
    return reply.code(201).send({ ...webhookMeta(hook), hmacSecret: secret });
  });

  app.get('/api/webhooks', { preHandler: requireAuth }, async () => {
    const hooks = await stores.webhooks.list();
    return { webhooks: hooks.map(webhookMeta) };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/webhooks/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const hook = await stores.webhooks.findById(req.params.id);
      if (!hook) return reply.code(404).send({ error: 'webhook_not_found' });
      await stores.webhooks.delete(hook.id);
      return reply.code(204).send();
    },
  );

  // -- security center -----------------------------------------------------------

  app.get(
    '/api/security/audit-logs',
    { preHandler: [requireAuth, requireOwner] },
    async (req) => {
      const query = req.query as { eventType?: string; limit?: string };
      const limit = query.limit ? Math.min(Math.max(Number(query.limit) || 0, 1), 500) : 100;
      const logs = await stores.audit.list({ eventType: query.eventType, limit });
      return { logs };
    },
  );

  app.get('/api/security/health-score', { preHandler: requireAuth }, async () => {
    const owner = await stores.users.findOwner();
    const factors = [
      {
        key: 'setupClosed',
        label: 'Setup completed — owner account claimed',
        passed: Boolean(owner),
        weight: 25,
      },
      {
        key: 'ownerTwoFactor',
        label: 'Owner two-factor authentication (TOTP) enabled',
        passed: Boolean(owner?.totpEnabled),
        weight: 25,
      },
      {
        key: 'loginThrottle',
        label: 'Brute-force login throttle active',
        passed: true,
        weight: 25,
      },
      {
        key: 'vaultKey',
        label: 'Vault master key configured (not ephemeral)',
        passed: masterKeyConfigured,
        weight: 25,
      },
    ];
    const score = factors.reduce((sum, f) => sum + (f.passed ? f.weight : 0), 0);
    return {
      score,
      maxScore: 100,
      factors,
      halted: stores.platform.isHalted(),
      computedAt: new Date(now()).toISOString(),
    };
  });

  app.post(
    '/api/security/kill-switch',
    { preHandler: [requireAuth, requireOwner] },
    async (req) => {
      stores.platform.halt();
      await audit(req, {
        userId: (req.authUser as UserRecord).id,
        eventType: 'kill_switch',
        severity: 'critical',
        details: {},
      });
      return { halted: true };
    },
  );

  app.post('/api/security/resume', { preHandler: [requireAuth, requireOwner] }, async (req) => {
    stores.platform.resume();
    await audit(req, {
      userId: (req.authUser as UserRecord).id,
      eventType: 'kill_switch_resume',
      severity: 'warning',
      details: {},
    });
    return { halted: false };
  });

  // -- webhook gateway (public, HMAC-authenticated) ------------------------------

  await app.register(async (hooks) => {
    // Raw-body parsers: the HMAC is computed over the exact bytes received.
    hooks.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );
    hooks.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    hooks.post<{ Params: { slug: string } }>('/hooks/:slug', async (req, reply) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const hook = await stores.webhooks.findBySlug(req.params.slug);
      if (!hook || !hook.isActive) return reply.code(404).send({ error: 'webhook_not_found' });
      if (stores.platform.isHalted()) {
        return reply.code(503).send({ error: 'platform_halted' });
      }
      if (hook.ipAllowlist.length > 0 && !hook.ipAllowlist.some((rule) => ipMatches(req.ip, rule))) {
        await audit(req, {
          eventType: 'webhook_ip_rejected',
          severity: 'warning',
          details: { slug: hook.slug, ip: req.ip },
        });
        return reply.code(403).send({ error: 'ip_not_allowed' });
      }

      const signature = header(req, 'x-code-brothers-signature');
      const nonce = header(req, 'x-code-brothers-nonce');
      const timestamp = header(req, 'x-code-brothers-timestamp');
      if (!signature || !nonce) {
        await audit(req, {
          eventType: 'webhook_signature_failed',
          severity: 'warning',
          details: { slug: hook.slug, reason: 'missing_signature_or_nonce' },
        });
        return reply.code(401).send({ error: 'missing_signature_or_nonce' });
      }
      if (timestamp !== undefined) {
        const parsed = Number(timestamp);
        const tsMs = Number.isFinite(parsed) ? (parsed < 1e12 ? parsed * 1000 : parsed) : NaN;
        if (!Number.isFinite(tsMs) || Math.abs(now() - tsMs) > timestampToleranceMs) {
          await audit(req, {
            eventType: 'webhook_signature_failed',
            severity: 'warning',
            details: { slug: hook.slug, reason: 'stale_timestamp' },
          });
          return reply.code(401).send({ error: 'stale_timestamp' });
        }
      }

      const secret = safeDecrypt(hook.hmacSecretEncrypted);
      if (!secret) return reply.code(500).send({ error: 'webhook_secret_unavailable' });
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      const provided = signature.trim().toLowerCase().replace(/^sha256=/, '');
      const expectedBuf = Buffer.from(expected, 'utf8');
      const providedBuf = Buffer.from(provided, 'utf8');
      if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
        await audit(req, {
          eventType: 'webhook_signature_failed',
          severity: 'critical',
          details: { slug: hook.slug, reason: 'invalid_signature' },
        });
        return reply.code(401).send({ error: 'invalid_signature' });
      }

      if (!stores.nonces.checkAndAdd(`${hook.id}:${nonce}`, nonceTtlMs)) {
        await audit(req, {
          eventType: 'webhook_replay_rejected',
          severity: 'warning',
          details: { slug: hook.slug },
        });
        return reply.code(409).send({ error: 'replay_detected' });
      }

      const workflow = await stores.workflows.findById(hook.workflowId);
      if (!workflow) return reply.code(500).send({ error: 'workflow_not_found' });

      let parsedBody: unknown = rawBody.toString('utf8');
      const contentType = header(req, 'content-type') ?? '';
      if (contentType.includes('application/json')) {
        try {
          parsedBody = JSON.parse(rawBody.toString('utf8'));
        } catch {
          parsedBody = rawBody.toString('utf8');
        }
      }
      const triggerNode = workflow.nodes.find((n) => n.type === 'core.webhookTrigger');
      try {
        const execution = await executeWorkflow(workflow, {
          triggerType: 'webhook',
          triggerNodeId: triggerNode?.id,
          triggerData: {
            method: 'POST',
            path: `/hooks/${hook.slug}`,
            headers: req.headers,
            query: req.query ?? {},
            body: parsedBody,
          },
        });
        await stores.webhooks.update(hook.id, { lastTriggeredAt: new Date(now()).toISOString() });
        return reply.code(202).send({ executionId: execution.id, status: execution.status });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Workflow execution failed';
        return reply
          .code(500)
          .send({ error: 'workflow_execution_failed', message: redactString(message) });
      }
    });
  });

  // -- first-boot setup token -----------------------------------------------------

  const ownerAtBoot = await stores.users.findOwner();
  const setupToken = ownerAtBoot ? undefined : setupTokenService.generateSetupToken();

  return { app, stores, setupTokenService, setupToken, masterKeyConfigured };
}
