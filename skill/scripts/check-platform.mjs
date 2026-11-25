#!/usr/bin/env node
/**
 * check-platform.mjs — fast health check for a code-brothers instance.
 *
 * Usage (from anywhere; the token is read from the environment only):
 *   CB_API_URL=http://127.0.0.1:3000 CB_API_TOKEN=<owner-token> node check-platform.mjs
 *
 * Prints setup state, the security health score, workflow count and
 * credential names (metadata only). The token is never printed.
 * Exit code 0 = the platform answers and setup is complete.
 */

const API = (process.env.CB_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = process.env.CB_API_TOKEN;

const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(name);
}

async function call(method, path, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function main() {
  if (!TOKEN) {
    console.error(
      'CB_API_TOKEN is required.\n' +
        'Log in once: curl -X POST $CB_API_URL/api/auth/login ' +
        "-d '{\"email\":\"owner@example.com\",\"password\":\"...\"}'\n" +
        'and set CB_API_TOKEN to the token from the response.',
    );
    process.exit(2);
  }

  let setup;
  try {
    setup = await call('GET', '/api/setup/status');
  } catch (err) {
    console.error(`FAIL  cannot reach the API at ${API}: ${err.message}`);
    process.exit(1);
  }
  check('API answers', setup.status === 200, `HTTP ${setup.status}`);
  check(
    'setup is complete (owner claimed)',
    setup.body?.setupRequired === false,
    JSON.stringify(setup.body),
  );

  const health = await call('GET', '/api/security/health-score', TOKEN);
  check('health score answers', health.status === 200, `HTTP ${health.status}`);
  if (health.status === 200) {
    console.log(`      health score: ${JSON.stringify(health.body)}`);
  }

  const workflows = await call('GET', '/api/workflows', TOKEN);
  check('workflows list answers', workflows.status === 200, `HTTP ${workflows.status}`);
  if (workflows.status === 200) {
    const list = workflows.body?.workflows ?? [];
    console.log(
      `      ${list.length} workflow(s): ` +
        (list.map((w) => `${w.name}${w.isActive ? ' (active)' : ''}`).join(', ') || '(none yet)'),
    );
  }

  const creds = await call('GET', '/api/credentials', TOKEN);
  check('credentials list answers', creds.status === 200, `HTTP ${creds.status}`);
  if (creds.status === 200) {
    const items = creds.body?.items ?? [];
    console.log(
      `      ${items.length} credential(s): ` +
        (items.map((c) => `${c.name} (${c.provider ?? c.kind ?? '?'})`).join(', ') || '(none yet — add yours in the Vault)'),
    );
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nPlatform looks healthy.');
}

main().catch((err) => {
  console.error('check-platform crashed:', err.message);
  process.exit(1);
});
