/**
 * Dashboard-proxy verification (gap 4).
 *
 * Proves the production-built dashboard reaches the API through the
 * nginx proxy in docker/nginx.conf:
 *   1. Builds the web app (apps/web/dist).
 *   2. Starts the real API on port 3000.
 *   3. Starts nginx with the SHIPPED server block — the only change is
 *      the upstream host (`api` -> 127.0.0.1), because `api` is a Docker
 *      compose service name that only resolves inside Docker's network.
 *      The script asserts that substitution is the ONLY difference.
 *   4. Checks: SPA index served at /, client routes fall back to the
 *      SPA, /api/* is proxied to the real API, /hooks/* is proxied too.
 *
 * Usage: node scripts/verify-dashboard-proxy.mjs
 * Requires: nginx installed, node, npm. No Docker needed.
 *
 * Exit code 0 = the production dashboard reaches the API through nginx.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/cb-nginx-test';
const NGINX_PORT = 8080;
const API_PORT = 3000;

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // 1. Build the web app.
  const build = spawnSync('npm', ['run', 'build', '--workspace=@code-brothers/web'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  check('web app builds', build.status === 0, build.status === 0 ? '' : (build.stderr ?? '').slice(-500));
  if (build.status !== 0) process.exit(1);
  check('built index.html exists', existsSync(join(ROOT, 'apps/web/dist/index.html')));

  // 2. The shipped server block, with only the upstream host and the
  // document root substituted: `api` is a Docker compose service name that
  // only resolves inside Docker's network, and the Dockerfile copies the
  // built SPA to /usr/share/nginx/html — locally it lives in apps/web/dist.
  const shipped = readFileSync(join(ROOT, 'docker/nginx.conf'), 'utf8');
  if (!shipped.includes('http://api:3000')) {
    check('shipped nginx.conf proxies /api + /hooks to api:3000', false, 'no http://api:3000 in docker/nginx.conf');
    process.exit(1);
  }
  const tested = shipped
    .replaceAll('http://api:3000', 'http://127.0.0.1:3000')
    .replace('root /usr/share/nginx/html;', `root ${join(ROOT, 'apps/web/dist')};`);
  const diffLines = shipped
    .split('\n')
    .filter((line, i) => line !== tested.split('\n')[i]);
  check(
    'test config differs from shipped ONLY in upstream host + docroot',
    diffLines.every((l) => l.includes('http://api:3000') || l.includes('root /usr/share/nginx/html')),
    `${diffLines.length} differing line(s)`,
  );

  mkdirSync(TMP, { recursive: true });
  const testConf = [
    // Run workers as the invoking user: the built SPA lives under the home
    // directory, which the packaged nginx user cannot traverse. (Test-only:
    // the Docker image runs as its own unprivileged UID with the files
    // copied into /usr/share/nginx/html.)
    `user ${userInfo().username};`,
    'worker_processes 1;',
    `pid ${TMP}/nginx.pid;`,
    `error_log ${TMP}/error.log;`,
    'events { worker_connections 64; }',
    'http {',
    '  include /etc/nginx/mime.types;',
    `  access_log ${TMP}/access.log;`,
    `  client_body_temp_path ${TMP}/body;`,
    `  proxy_temp_path ${TMP}/proxy;`,
    `  fastcgi_temp_path ${TMP}/fastcgi;`,
    `  uwsgi_temp_path ${TMP}/uwsgi;`,
    `  scgi_temp_path ${TMP}/scgi;`,
    tested,
    '}',
    '',
  ].join('\n');
  writeFileSync(join(TMP, 'nginx.conf'), testConf);

  const nginxTest = spawnSync('nginx', ['-t', '-c', join(TMP, 'nginx.conf'), '-p', TMP], {
    encoding: 'utf8',
  });
  check('nginx accepts the server block', nginxTest.status === 0, (nginxTest.stderr ?? '').trim().split('\n').pop() ?? '');

  // 3. Start the real API.
  const api = spawn('node', ['apps/api/dist/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      CB_MASTER_KEY: randomBytes(32).toString('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let apiUp = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/api/setup/status`);
      if (r.status === 200) {
        apiUp = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  check('API up on 3000', apiUp);

  // 4. Start nginx with the test config.
  const nginxStart = spawnSync('nginx', ['-c', join(TMP, 'nginx.conf'), '-p', TMP], { encoding: 'utf8' });
  check('nginx starts', nginxStart.status === 0, (nginxStart.stderr ?? '').trim().slice(-300));
  await sleep(500);

  try {
    const base = `http://127.0.0.1:${NGINX_PORT}`;

    const index = await fetch(base + '/');
    const indexText = await index.text();
    check('SPA index served at /', index.status === 200 && indexText.includes('<div id="root"'), `status ${index.status}`);

    const clientRoute = await fetch(base + '/workflows');
    const clientText = await clientRoute.text();
    check(
      'client route /workflows falls back to the SPA',
      clientRoute.status === 200 && clientText.includes('<div id="root"'),
      `status ${clientRoute.status}`,
    );

    const apiStatus = await fetch(base + '/api/setup/status');
    const apiJson = await apiStatus.json().catch(() => null);
    check(
      '/api/setup/status proxied to the real API',
      apiStatus.status === 200 && apiJson?.setupRequired === true,
      `status ${apiStatus.status} ${JSON.stringify(apiJson)?.slice(0, 80)}`,
    );

    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'x' }),
    });
    check(
      'POST /api/auth/login reaches the API (401 invalid_credentials, not an nginx 404)',
      login.status === 401,
      `status ${login.status}`,
    );

    const hook = await fetch(base + '/hooks/nope', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    check('/hooks/* proxied to the API (404 webhook_not_found)', hook.status === 404, `status ${hook.status}`);
  } finally {
    spawnSync('nginx', ['-s', 'quit', '-c', join(TMP, 'nginx.conf'), '-p', TMP]);
    api.kill('SIGTERM');
    await sleep(500);
    if (!api.killed) api.kill('SIGKILL');
  }

  console.log('');
  if (failures.length === 0) {
    console.log('DASHBOARD PROXY VERIFIED: the production-built SPA reaches the API through nginx.');
  } else {
    console.log(`${failures.length} check(s) FAILED: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
