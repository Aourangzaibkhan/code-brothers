#!/usr/bin/env node
/**
 * Verify gap 5 (AI Copilot) live against a MOCK Ollama server.
 *
 *   1. Spins up a fake Ollama on localhost (POST /api/chat returns a canned
 *      reply) and the real API with OLLAMA_HOST pointed at it.
 *   2. Claims setup, logs in, calls GET /api/ai/status (must show the
 *      ollama provider) and POST /api/ai/chat (must return the mock's text
 *      with provider 'ollama').
 *   3. Restarts the API with NO provider env keys and proves POST
 *      /api/ai/chat answers 503 `no_ai_provider_configured` — the endpoint
 *      never fakes an AI reply.
 *
 * No real AI key is used anywhere. Run:
 *   node scripts/verify-ai-chat.mjs [--api-port 3002] [--ollama-port 11435]
 *
 * Env: CB_MASTER_KEY (default: generated at runtime — never hardcode one).
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const API_PORT = Number(process.argv.find((a) => a.startsWith('--api-port='))?.split('=')[1] ?? 3002);
const OLLAMA_PORT = Number(
  process.argv.find((a) => a.startsWith('--ollama-port='))?.split('=')[1] ?? 11435,
);
const API = `http://127.0.0.1:${API_PORT}`;

const OWNER_PASSWORD = randomBytes(16).toString('hex');
let checks = 0;
let failures = 0;

function check(name, ok, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function api(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

function spawnApi(masterKey, extraEnv) {
  const child = spawn('node', ['apps/api/dist/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      CB_MASTER_KEY: masterKey,
      // No DATABASE_URL -> in-memory stores (fine for this check).
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  return {
    child,
    getOutput: () => output,
    waitReady: async () => {
      for (let i = 0; i < 50; i++) {
        try {
          const res = await fetch(`${API}/api/setup/status`);
          if (res.ok) return;
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`API did not come up on ${API_PORT}:\n${output}`);
    },
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }),
  };
}

async function main() {
  // --- mock Ollama: POST /api/chat -> canned reply -----------------------
  let ollamaCalls = 0;
  const ollama = await listen(
    createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        ollamaCalls++;
        let parsed = {};
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          /* ignore */
        }
        const model = parsed.model ?? 'qwen2.5:7b';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            model,
            message: {
              role: 'assistant',
              content: 'Use a webhook trigger, then whatsapp.sendMessage.',
            },
            done: true,
            prompt_eval_count: 10,
            eval_count: 20,
          }),
        );
      });
    }),
    OLLAMA_PORT,
  );
  console.log(`mock Ollama on http://127.0.0.1:${OLLAMA_PORT}`);

  const masterKey = process.env.CB_MASTER_KEY ?? randomBytes(32).toString('hex');

  // --- phase 1: API with OLLAMA_HOST -------------------------------------
  console.log('phase 1: API with OLLAMA_HOST (mock)');
  const api1 = spawnApi(masterKey, { OLLAMA_HOST: `http://127.0.0.1:${OLLAMA_PORT}` });
  try {
    await api1.waitReady();
    const setupToken = api1
      .getOutput()
      .match(/setup token: ([A-Za-z0-9_-]+)/i)?.[1];
    if (!setupToken) throw new Error('no setup token in API output:\n' + api1.getOutput());
    const claim = await api('POST', '/api/setup/claim', undefined, {
      setupToken,
      email: 'owner@example.com',
      password: OWNER_PASSWORD,
    });
    check('setup claim succeeds', claim.status === 201, JSON.stringify(claim.body));
    const token = claim.body.token;
    check('login token returned', typeof token === 'string' && token.length > 0);

    const status = await api('GET', '/api/ai/status', token);
    check('GET /api/ai/status is 200', status.status === 200, JSON.stringify(status.body));
    check('status shows ollama configured', status.body.configured === true);
    check(
      'status lists ollama provider',
      Array.isArray(status.body.providers) && status.body.providers.includes('ollama'),
      JSON.stringify(status.body.providers),
    );

    const chat = await api('POST', '/api/ai/chat', token, {
      messages: [{ role: 'user', content: 'how do I send a WhatsApp message?' }],
    });
    check('POST /api/ai/chat is 200', chat.status === 200, JSON.stringify(chat.body));
    check('chat text is the mock Ollama reply', chat.body.text === 'Use a webhook trigger, then whatsapp.sendMessage.');
    check('chat provider is ollama', chat.body.provider === 'ollama', String(chat.body.provider));
    check('mock Ollama was actually called', ollamaCalls >= 1, `calls=${ollamaCalls}`);

    const bad = await api('POST', '/api/ai/chat', token, { messages: [] });
    check('empty messages -> 400', bad.status === 400, JSON.stringify(bad.body));

    const unauth = await api('POST', '/api/ai/chat', undefined, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    check('unauthenticated chat -> 401', unauth.status === 401, JSON.stringify(unauth.body));
  } finally {
    await api1.stop();
  }

  // --- phase 2: API with NO provider keys -> honest 503 -------------------
  console.log('phase 2: API with no AI provider keys');
  const cleanEnv = {
    OLLAMA_HOST: undefined,
    GEMINI_API_KEY: undefined,
    GROQ_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
  };
  const api2 = spawnApi(masterKey, cleanEnv);
  try {
    await api2.waitReady();
    // Owner already claimed in phase 1? No — phase 1 used in-memory stores,
    // so this fresh process needs a fresh claim.
    const setupToken = api2
      .getOutput()
      .match(/setup token: ([A-Za-z0-9_-]+)/i)?.[1];
    if (!setupToken) throw new Error('no setup token in API output:\n' + api2.getOutput());
    const claim = await api('POST', '/api/setup/claim', undefined, {
      setupToken,
      email: 'owner@example.com',
      password: OWNER_PASSWORD,
    });
    check('setup claim succeeds (phase 2)', claim.status === 201, JSON.stringify(claim.body));
    const token = claim.body.token;

    const status = await api('GET', '/api/ai/status', token);
    check('status shows not configured', status.body.configured === false);
    check(
      'status message says how to configure',
      typeof status.body.message === 'string' && status.body.message.includes('OLLAMA_HOST'),
      JSON.stringify(status.body.message),
    );

    const chat = await api('POST', '/api/ai/chat', token, {
      messages: [{ role: 'user', content: 'hello' }],
    });
    check('chat with no provider -> 503', chat.status === 503, JSON.stringify(chat.body));
    check(
      '503 error is no_ai_provider_configured',
      chat.body.error === 'no_ai_provider_configured',
      JSON.stringify(chat.body),
    );
  } finally {
    await api2.stop();
    ollama.close();
  }

  console.log(`\nAI CHAT: ${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    console.log('AI CHAT VERIFICATION FAILED');
    process.exitCode = 1;
  } else {
    console.log('AI CHAT VERIFIED: real model routing via mock Ollama + honest 503 with no keys.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
