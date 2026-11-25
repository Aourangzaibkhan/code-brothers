/**
 * End-to-end API tests (fastify inject) against the in-memory stores.
 * Covers: setup claim, login + TOTP, throttle lockout, write-only vault,
 * workflow versioning + execution, the HMAC webhook gateway, and the
 * security center (audit log, health score, kill switch).
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';
import { generateMasterKey, parseMasterKey, totpCode } from '@code-brothers/security';
import { buildApp, type BuiltApi } from './app.js';

const MASTER_KEY = parseMasterKey(generateMasterKey());
const OWNER_EMAIL = 'owner@example.com';
const OWNER_PASSWORD = 'correct horse battery';

async function makeApi(t: TestContext): Promise<BuiltApi> {
  const built = await buildApp({ masterKey: MASTER_KEY });
  t.after(async () => {
    await built.app.close();
  });
  return built;
}

interface ClaimBody {
  token: string;
  totpSecret?: string;
  user: { id: string; email: string; role: string };
}

async function claimOwner(
  built: BuiltApi,
  extra: Record<string, unknown> = {},
): Promise<ClaimBody> {
  const res = await built.app.inject({
    method: 'POST',
    url: '/api/setup/claim',
    payload: {
      setupToken: built.setupToken,
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      ...extra,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as ClaimBody;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function login(
  built: BuiltApi,
  extra: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await built.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD, ...extra },
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

const THREE_NODE_WORKFLOW = {
  name: 'Greeting flow',
  nodes: [
    { id: 'trigger', type: 'core.manualTrigger', name: 'Start', parameters: {} },
    {
      id: 'set',
      type: 'core.setData',
      name: 'Set',
      parameters: {
        assignments: [{ name: 'fullName', value: '{{ $json.first }} {{ $json.last }}' }],
      },
    },
    { id: 'log', type: 'core.log', name: 'Log', parameters: {} },
  ],
  edges: [
    { from: 'trigger', to: 'set' },
    { from: 'set', to: 'log' },
  ],
};

async function createWorkflow(
  built: BuiltApi,
  token: string,
  workflow: Record<string, unknown> = THREE_NODE_WORKFLOW,
): Promise<Record<string, unknown>> {
  const res = await built.app.inject({
    method: 'POST',
    url: '/api/workflows',
    headers: auth(token),
    payload: workflow,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as Record<string, unknown>;
}

describe('setup & auth', () => {
  it('claims the owner once, then setup is permanently closed', async (t) => {
    const built = await makeApi(t);

    const statusBefore = await built.app.inject({ method: 'GET', url: '/api/setup/status' });
    assert.equal((statusBefore.json() as { setupRequired: boolean }).setupRequired, true);

    const bad = await built.app.inject({
      method: 'POST',
      url: '/api/setup/claim',
      payload: { setupToken: 'not-the-token', email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });
    assert.equal(bad.statusCode, 401);

    const claim = await claimOwner(built);
    assert.equal(claim.user.email, OWNER_EMAIL);
    assert.equal(claim.user.role, 'owner');
    assert.ok(claim.token.length > 20);

    const statusAfter = await built.app.inject({ method: 'GET', url: '/api/setup/status' });
    const after = statusAfter.json() as { setupRequired: boolean; setupClosed: boolean };
    assert.equal(after.setupRequired, false);
    assert.equal(after.setupClosed, true);

    const second = await built.app.inject({
      method: 'POST',
      url: '/api/setup/claim',
      payload: { setupToken: built.setupToken, email: 'other@example.com', password: OWNER_PASSWORD },
    });
    assert.equal(second.statusCode, 403);
  });

  it('logs in, serves /me, lists + revokes sessions, and logs out', async (t) => {
    const built = await makeApi(t);
    const claim = await claimOwner(built); // the claim itself opens session #1

    const wrong = await login(built, { password: 'wrong password' });
    assert.equal(wrong.statusCode, 401);

    const second = await login(built); // session #2
    assert.equal(second.statusCode, 200);
    const token2 = second.body.token as string;

    const anon = await built.app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(anon.statusCode, 401);

    const me = await built.app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(token2) });
    assert.equal(me.statusCode, 200);
    assert.equal((me.json() as { user: { email: string } }).user.email, OWNER_EMAIL);

    const sessionsRes = await built.app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: auth(token2),
    });
    const sessions = (sessionsRes.json() as { sessions: Array<{ id: string; revokedAt?: string; current: boolean }> }).sessions;
    assert.equal(sessions.length, 2);
    assert.equal(sessions.filter((s) => s.current).length, 1);

    const otherSession = sessions.find((s) => !s.current) as { id: string };
    const revoke = await built.app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${otherSession.id}`,
      headers: auth(token2),
    });
    assert.equal(revoke.statusCode, 204);

    // The revoked session was the one created by the setup claim.
    const meRevoked = await built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(claim.token),
    });
    assert.equal(meRevoked.statusCode, 401);

    const logout = await built.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: auth(token2),
    });
    assert.equal(logout.statusCode, 204);
    const meAfterLogout = await built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(token2),
    });
    assert.equal(meAfterLogout.statusCode, 401);
  });
});

describe('TOTP two-factor', () => {
  it('supports TOTP enrolment at setup claim time', async (t) => {
    const built = await makeApi(t);
    const claim = await claimOwner(built, { enableTotp: true });
    assert.ok(claim.totpSecret, 'claim returns the one-time TOTP secret');

    const noCode = await login(built);
    assert.equal(noCode.statusCode, 401);
    assert.equal(noCode.body.error, 'totp_required');

    const badCode = await login(built, { totpCode: '000000' });
    assert.equal(badCode.statusCode, 401);
    assert.equal(badCode.body.error, 'invalid_totp_code');

    const good = await login(built, { totpCode: totpCode(claim.totpSecret as string) });
    assert.equal(good.statusCode, 200);
    assert.ok(good.body.token);

    const health = await built.app.inject({
      method: 'GET',
      url: '/api/security/health-score',
      headers: auth(good.body.token as string),
    });
    assert.equal((health.json() as { score: number }).score, 100);
  });

  it('supports the enrol -> confirm -> required -> disable flow', async (t) => {
    const built = await makeApi(t);
    await claimOwner(built);
    const { body } = await login(built);
    const token = body.token as string;

    const enrol = await built.app.inject({
      method: 'POST',
      url: '/api/auth/totp/enrol',
      headers: auth(token),
    });
    assert.equal(enrol.statusCode, 200);
    const { secret } = enrol.json() as { secret: string };
    assert.ok(secret.length >= 16);

    const confirm = await built.app.inject({
      method: 'POST',
      url: '/api/auth/totp/confirm',
      headers: auth(token),
      payload: { code: totpCode(secret) },
    });
    assert.equal(confirm.statusCode, 200);

    const noCode = await login(built);
    assert.equal(noCode.statusCode, 401);
    assert.equal(noCode.body.error, 'totp_required');

    const withCode = await login(built, { totpCode: totpCode(secret) });
    assert.equal(withCode.statusCode, 200);
    const token2 = withCode.body.token as string;

    const disable = await built.app.inject({
      method: 'POST',
      url: '/api/auth/totp/disable',
      headers: auth(token2),
      payload: { code: totpCode(secret) },
    });
    assert.equal(disable.statusCode, 200);

    const afterDisable = await login(built);
    assert.equal(afterDisable.statusCode, 200);
  });
});

describe('login throttle', () => {
  it('locks the account after 5 failed logins, even for the right password', async (t) => {
    const built = await makeApi(t);
    await claimOwner(built);

    for (let i = 0; i < 5; i++) {
      const res = await login(built, { password: `wrong-${i}` });
      assert.equal(res.statusCode, 401, `attempt ${i + 1}`);
    }
    const locked = await login(built);
    assert.equal(locked.statusCode, 429);
    assert.equal(locked.body.error, 'too_many_attempts');
  });
});

describe('credentials vault (write-only)', () => {
  it('stores secrets and never returns them on any read', async (t) => {
    const built = await makeApi(t);
    const claim = await claimOwner(built);
    const token = claim.token;

    const secretValue = 'shpat_super_secret_12345';
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: auth(token),
      payload: { name: 'shopify-main', provider: 'shopify', value: secretValue },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.ok(!created.body.includes(secretValue), 'create response must not echo the secret');
    const meta = created.json() as { id: string; name: string; provider: string; createdAt: string };
    assert.equal(meta.name, 'shopify-main');
    assert.equal(meta.provider, 'shopify');
    assert.ok(meta.createdAt);

    const objectSecret = 'obj_secret_67890';
    const createdObj = await built.app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: auth(token),
      payload: { name: 'ai-keys', provider: 'gemini', value: { apiKey: objectSecret } },
    });
    assert.equal(createdObj.statusCode, 201);
    assert.ok(!createdObj.body.includes(objectSecret));

    const list = await built.app.inject({
      method: 'GET',
      url: '/api/credentials',
      headers: auth(token),
    });
    assert.equal(list.statusCode, 200);
    assert.ok(!list.body.includes(secretValue));
    assert.ok(!list.body.includes(objectSecret));
    assert.equal((list.json() as { items: unknown[] }).items.length, 2);

    const one = await built.app.inject({
      method: 'GET',
      url: `/api/credentials/${meta.id}`,
      headers: auth(token),
    });
    assert.equal(one.statusCode, 200);
    assert.ok(!one.body.includes(secretValue));
    assert.equal((one.json() as { name: string }).name, 'shopify-main');

    const duplicate = await built.app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: auth(token),
      payload: { name: 'shopify-main', provider: 'shopify', value: 'another' },
    });
    assert.equal(duplicate.statusCode, 409);

    const removed = await built.app.inject({
      method: 'DELETE',
      url: `/api/credentials/${meta.id}`,
      headers: auth(token),
    });
    assert.equal(removed.statusCode, 204);
    const gone = await built.app.inject({
      method: 'GET',
      url: `/api/credentials/${meta.id}`,
      headers: auth(token),
    });
    assert.equal(gone.statusCode, 404);
  });
});

describe('workflows', () => {
  it('versions every save and runs a real 3-node workflow', async (t) => {
    const built = await makeApi(t);
    const claim = await claimOwner(built);
    const token = claim.token;

    const anon = await built.app.inject({ method: 'GET', url: '/api/workflows' });
    assert.equal(anon.statusCode, 401);

    const workflow = await createWorkflow(built, token);
    assert.equal(workflow.currentVersion, 1);
    const workflowId = workflow.id as string;

    const updatedNodes = THREE_NODE_WORKFLOW.nodes.map((n) =>
      n.id === 'set'
        ? {
            ...n,
            parameters: {
              assignments: [{ name: 'greeting', value: 'Hello {{ $json.first }} {{ $json.last }}' }],
            },
          }
        : n,
    );
    const updated = await built.app.inject({
      method: 'PUT',
      url: `/api/workflows/${workflowId}`,
      headers: auth(token),
      payload: { nodes: updatedNodes, comment: 'friendlier greeting' },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal((updated.json() as { currentVersion: number }).currentVersion, 2);

    const versions = await built.app.inject({
      method: 'GET',
      url: `/api/workflows/${workflowId}/versions`,
      headers: auth(token),
    });
    const versionRows = (versions.json() as { versions: Array<{ version: number; comment?: string }> }).versions;
    assert.equal(versionRows.length, 2);
    assert.deepEqual(versionRows.map((v) => v.version), [1, 2]);
    assert.equal(versionRows[1].comment, 'friendlier greeting');

    const activated = await built.app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/activate`,
      headers: auth(token),
    });
    assert.equal((activated.json() as { isActive: boolean }).isActive, true);

    const run = await built.app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/run`,
      headers: auth(token),
      payload: { triggerData: { first: 'Ada', last: 'Lovelace' } },
    });
    assert.equal(run.statusCode, 201, run.body);
    const execution = run.json() as {
      id: string;
      status: string;
      triggerType: string;
      workflowVersion: number;
      steps: Array<{ nodeId: string; status: string; output: unknown }>;
    };
    assert.equal(execution.status, 'success');
    assert.equal(execution.triggerType, 'manual');
    assert.equal(execution.workflowVersion, 2);
    assert.equal(execution.steps.length, 3);
    assert.ok(execution.steps.every((s) => s.status === 'success'));
    const setStep = execution.steps.find((s) => s.nodeId === 'set') as { output: unknown };
    assert.ok(JSON.stringify(setStep.output).includes('Hello Ada Lovelace'));

    const fetched = await built.app.inject({
      method: 'GET',
      url: `/api/executions/${execution.id}`,
      headers: auth(token),
    });
    assert.equal(fetched.statusCode, 200);
    assert.equal((fetched.json() as { id: string }).id, execution.id);

    const list = await built.app.inject({
      method: 'GET',
      url: `/api/executions?workflowId=${workflowId}`,
      headers: auth(token),
    });
    assert.equal((list.json() as { executions: unknown[] }).executions.length, 1);
  });
});

describe('webhook gateway', () => {
  const WEBHOOK_WORKFLOW = {
    name: 'Order hook',
    nodes: [
      { id: 'hook', type: 'core.webhookTrigger', name: 'Hook', parameters: {} },
      {
        id: 'set',
        type: 'core.setData',
        name: 'Set',
        parameters: { assignments: [{ name: 'orderId', value: '{{ $json.orderId }}' }] },
      },
      { id: 'log', type: 'core.log', name: 'Log', parameters: {} },
    ],
    edges: [
      { from: 'hook', to: 'set' },
      { from: 'set', to: 'log' },
    ],
  };

  function sign(secret: string, raw: string): string {
    return createHmac('sha256', secret).update(raw).digest('hex');
  }

  it('verifies HMAC, rejects replays and bad signatures, and audits failures', async (t) => {
    const built = await makeApi(t);
    const claim = await claimOwner(built);
    const token = claim.token;
    const workflow = await createWorkflow(built, token, WEBHOOK_WORKFLOW);

    const hookRes = await built.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: auth(token),
      payload: { workflowId: workflow.id, slug: 'orders' },
    });
    assert.equal(hookRes.statusCode, 201, hookRes.body);
    const hook = hookRes.json() as { id: string; slug: string; hmacSecret: string };
    assert.ok(hook.hmacSecret.length >= 32);

    const raw = JSON.stringify({ orderId: 'A-100' });
    const good = await built.app.inject({
      method: 'POST',
      url: '/hooks/orders',
      headers: {
        'content-type': 'application/json',
        'x-code-brothers-signature': sign(hook.hmacSecret, raw),
        'x-code-brothers-nonce': 'nonce-1',
      },
      payload: raw,
    });
    assert.equal(good.statusCode, 202, good.body);
    const { executionId } = good.json() as { executionId: string };
    assert.ok(executionId);

    const executionRes = await built.app.inject({
      method: 'GET',
      url: `/api/executions/${executionId}`,
      headers: auth(token),
    });
    const execution = executionRes.json() as { triggerType: string; status: string };
    assert.equal(execution.triggerType, 'webhook');
    assert.equal(execution.status, 'success');

    const replay = await built.app.inject({
      method: 'POST',
      url: '/hooks/orders',
      headers: {
        'content-type': 'application/json',
        'x-code-brothers-signature': sign(hook.hmacSecret, raw),
        'x-code-brothers-nonce': 'nonce-1',
      },
      payload: raw,
    });
    assert.equal(replay.statusCode, 409);

    const badSig = await built.app.inject({
      method: 'POST',
      url: '/hooks/orders',
      headers: {
        'content-type': 'application/json',
        'x-code-brothers-signature': sign('the-wrong-secret', raw),
        'x-code-brothers-nonce': 'nonce-2',
      },
      payload: raw,
    });
    assert.equal(badSig.statusCode, 401);

    const auditRes = await built.app.inject({
      method: 'GET',
      url: '/api/security/audit-logs?eventType=webhook_signature_failed',
      headers: auth(token),
    });
    const logs = (auditRes.json() as { logs: Array<{ eventType: string }> }).logs;
    assert.ok(logs.length >= 1);
    assert.ok(logs.every((l) => l.eventType === 'webhook_signature_failed'));

    const unknown = await built.app.inject({
      method: 'POST',
      url: '/hooks/nope',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    assert.equal(unknown.statusCode, 404);
  });

  it('enforces the IP allowlist', async (t) => {
    const built = await makeApi(t);
    const claim = await claimOwner(built);
    const workflow = await createWorkflow(built, claim.token, WEBHOOK_WORKFLOW);
    const hookRes = await built.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: auth(claim.token),
      payload: { workflowId: workflow.id, slug: 'restricted', ipAllowlist: ['10.0.0.0/8'] },
    });
    const hook = hookRes.json() as { hmacSecret: string };
    const raw = JSON.stringify({ orderId: 'B-1' });
    const res = await built.app.inject({
      method: 'POST',
      url: '/hooks/restricted',
      headers: {
        'content-type': 'application/json',
        'x-code-brothers-signature': sign(hook.hmacSecret, raw),
        'x-code-brothers-nonce': 'n-1',
      },
      payload: raw,
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('security center', () => {
  it('computes a health score with the documented factors', async (t) => {
    const built = await makeApi(t);
    const claim = await claimOwner(built);
    const res = await built.app.inject({
      method: 'GET',
      url: '/api/security/health-score',
      headers: auth(claim.token),
    });
    assert.equal(res.statusCode, 200);
    const health = res.json() as {
      score: number;
      maxScore: number;
      halted: boolean;
      factors: Array<{ key: string; passed: boolean; weight: number }>;
    };
    assert.equal(health.maxScore, 100);
    assert.deepEqual(
      health.factors.map((f) => f.key).sort(),
      ['loginThrottle', 'ownerTwoFactor', 'setupClosed', 'vaultKey'],
    );
    // Owner claimed + throttle + configured vault key, but no TOTP yet.
    assert.equal(health.score, 75);
    assert.equal(health.halted, false);
  });

  it('kill switch halts runs and webhooks until resume', async (t) => {
    const built = await makeApi(t);
    const claim = await claimOwner(built);
    const token = claim.token;
    const workflow = await createWorkflow(built, token);
    const workflowId = workflow.id as string;

    const hookRes = await built.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: auth(token),
      payload: { workflowId, slug: 'freeze-test' },
    });
    const hook = hookRes.json() as { hmacSecret: string };

    const runBefore = await built.app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/run`,
      headers: auth(token),
      payload: { triggerData: { first: 'Ada', last: 'Lovelace' } },
    });
    assert.equal(runBefore.statusCode, 201);

    const kill = await built.app.inject({
      method: 'POST',
      url: '/api/security/kill-switch',
      headers: auth(token),
    });
    assert.equal(kill.statusCode, 200);
    assert.equal((kill.json() as { halted: boolean }).halted, true);

    const runHalted = await built.app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/run`,
      headers: auth(token),
      payload: {},
    });
    assert.equal(runHalted.statusCode, 503);

    const raw = JSON.stringify({ orderId: 'C-1' });
    const hookHalted = await built.app.inject({
      method: 'POST',
      url: '/hooks/freeze-test',
      headers: {
        'content-type': 'application/json',
        'x-code-brothers-signature': createHmac('sha256', hook.hmacSecret).update(raw).digest('hex'),
        'x-code-brothers-nonce': 'freeze-1',
      },
      payload: raw,
    });
    assert.equal(hookHalted.statusCode, 503);

    const auditRes = await built.app.inject({
      method: 'GET',
      url: '/api/security/audit-logs?eventType=kill_switch',
      headers: auth(token),
    });
    assert.equal((auditRes.json() as { logs: unknown[] }).logs.length, 1);

    const resume = await built.app.inject({
      method: 'POST',
      url: '/api/security/resume',
      headers: auth(token),
    });
    assert.equal((resume.json() as { halted: boolean }).halted, false);

    const runAfter = await built.app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/run`,
      headers: auth(token),
      payload: { triggerData: { first: 'Ada', last: 'Lovelace' } },
    });
    assert.equal(runAfter.statusCode, 201);
  });
});

describe('AI Copilot chat', () => {
  it('routes a chat through the injected provider and reports status', async (t) => {
    const stubRouter = {
      name: 'hybrid-router',
      coolingDown: () => [],
      route: async () => ({
        result: {
          text: 'Use a webhook trigger, then whatsapp.sendMessage.',
          provider: 'stub',
          model: 'stub-model',
        },
        provider: 'stub',
        attempts: [{ provider: 'stub', ok: true }],
      }),
    };
    const built = await buildApp({
      masterKey: MASTER_KEY,
      ai: {
        router: stubRouter as unknown as import('./modules/ai-chat.js').NamedRouter['router'],
        providerNames: ['stub'],
      },
    });
    t.after(async () => {
      await built.app.close();
    });
    const claim = await claimOwner(built);
    const token = claim.token;

    const status = await built.app.inject({
      method: 'GET',
      url: '/api/ai/status',
      headers: auth(token),
    });
    assert.equal(status.statusCode, 200);
    assert.equal((status.json() as { configured: boolean }).configured, true);
    assert.deepEqual((status.json() as { providers: string[] }).providers, ['stub']);

    const chat = await built.app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers: auth(token),
      payload: { messages: [{ role: 'user', content: 'how do I send a WhatsApp message?' }] },
    });
    assert.equal(chat.statusCode, 200, chat.body);
    const body = chat.json() as { text: string; provider: string; model: string };
    assert.equal(body.provider, 'stub');
    assert.equal(body.model, 'stub-model');
    assert.match(body.text, /webhook trigger/);

    const bad = await built.app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers: auth(token),
      payload: { messages: [] },
    });
    assert.equal(bad.statusCode, 400);
  });

  it('answers 503 with no provider configured (never fakes an AI reply)', async (t) => {
    const built = await buildApp({
      masterKey: MASTER_KEY,
      ai: { router: null, providerNames: [] },
    });
    t.after(async () => {
      await built.app.close();
    });
    const claim = await claimOwner(built);
    const token = claim.token;

    const status = await built.app.inject({
      method: 'GET',
      url: '/api/ai/status',
      headers: auth(token),
    });
    assert.equal((status.json() as { configured: boolean }).configured, false);

    const chat = await built.app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers: auth(token),
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(chat.statusCode, 503);
    assert.equal((chat.json() as { error: string }).error, 'no_ai_provider_configured');
  });
});
