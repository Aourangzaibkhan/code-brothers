import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SsrfError, assertUrlAllowed, isBlockedIp } from './ssrf.js';

const PUBLIC_RESOLVER = async (hostname: string) => {
  if (hostname === 'shop.example.com') return [{ address: '93.184.216.34', family: 4 }];
  if (hostname === 'dual.example.com') {
    return [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
  }
  throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
};

test('blocks the cloud metadata address 169.254.169.254', async () => {
  await assert.rejects(() => assertUrlAllowed('http://169.254.169.254/latest/meta-data/'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://169.254.169.254.nip.io/', { resolve: async () => [{ address: '169.254.169.254', family: 4 }] }), /blocked IP/u);
});

test('blocks loopback IPs in all notations', async () => {
  await assert.rejects(() => assertUrlAllowed('http://127.0.0.1/admin'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://127.0.0.1:6379/'), /Blocked IP/u);
  await assert.rejects(() => assertUrlAllowed('https://127.255.0.9/'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://[::1]/'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://0.0.0.0/'), SsrfError);
});

test('blocks private LAN ranges', async () => {
  for (const ip of ['10.0.0.5', '10.255.255.1', '172.16.0.10', '172.31.255.255', '192.168.1.1', '100.64.1.1']) {
    await assert.rejects(() => assertUrlAllowed(`http://${ip}/`), SsrfError, ip);
  }
});

test('blocks IPv6 private/link-local/ULA and IPv4-mapped blocked addresses', async () => {
  await assert.rejects(() => assertUrlAllowed('http://[fe80::1]/'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://[fd00::1]/'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://[::ffff:127.0.0.1]/'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://[::ffff:169.254.169.254]/'), SsrfError);
});

test('allows a public IPv4-mapped IPv6 address', async () => {
  const out = await assertUrlAllowed('http://[::ffff:93.184.216.34]/');
  // Node's URL parser normalizes the mapped form to hex groups.
  assert.equal(out.resolvedIp, '::ffff:5db8:d822');
  assert.equal(isBlockedIp(out.resolvedIp), false);
});

test('blocks localhost and internal service hostnames without DNS', async () => {
  await assert.rejects(() => assertUrlAllowed('http://localhost:3000/'), /internal\/localhost/u);
  await assert.rejects(() => assertUrlAllowed('http://foo.localhost/'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://postgres:5432/'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://redis:6379/'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://ollama:11434/api'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://metadata.google.internal/'), SsrfError);
});

test('blocks non-http(s) schemes and URLs with embedded credentials', async () => {
  await assert.rejects(() => assertUrlAllowed('file:///etc/passwd'), /scheme/u);
  await assert.rejects(() => assertUrlAllowed('ftp://example.com/x'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('gopher://example.com/'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://user:pass@93.184.216.34/'), /credentials/u);
});

test('allows a public IP literal and returns it as the pin target', async () => {
  const out = await assertUrlAllowed('https://93.184.216.34/path?q=1');
  assert.equal(out.resolvedIp, '93.184.216.34');
  assert.deepEqual(out.resolvedIps, ['93.184.216.34']);
  assert.equal(out.hostname, '93.184.216.34');
  assert.equal(out.url.protocol, 'https:');
});

test('allows a hostname resolving only to public IPs', async () => {
  const out = await assertUrlAllowed('https://shop.example.com/webhook', { resolve: PUBLIC_RESOLVER });
  assert.equal(out.resolvedIp, '93.184.216.34');
  const dual = await assertUrlAllowed('https://dual.example.com/', { resolve: PUBLIC_RESOLVER });
  assert.equal(dual.resolvedIps.length, 2);
});

test('blocks a hostname when ANY resolved address is private (DNS rebinding defense)', async () => {
  const sneaky = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '192.168.0.25', family: 4 },
  ];
  await assert.rejects(() => assertUrlAllowed('https://evil.example.com/', { resolve: sneaky }), /blocked IP/u);
  const metadata = async () => [{ address: '169.254.169.254', family: 4 }];
  await assert.rejects(() => assertUrlAllowed('https://evil.example.com/', { resolve: metadata }), SsrfError);
});

test('DNS failure is an SsrfError, not a silent pass', async () => {
  await assert.rejects(() => assertUrlAllowed('https://missing.example.com/', { resolve: PUBLIC_RESOLVER }), /DNS resolution failed/u);
  const empty = async () => [];
  await assert.rejects(() => assertUrlAllowed('https://x.example.com/', { resolve: empty }), /no addresses/u);
});

test('allowlist permits an intentional local target by IP, hostname and CIDR', async () => {
  const byIp = await assertUrlAllowed('http://192.168.1.50:8080/store', { allowlist: ['192.168.1.50'] });
  assert.equal(byIp.resolvedIp, '192.168.1.50');
  const byCidr = await assertUrlAllowed('http://192.168.1.51/', { allowlist: ['192.168.1.0/24'] });
  assert.equal(byCidr.resolvedIp, '192.168.1.51');
  const byHost = await assertUrlAllowed('http://localhost:9000/', { allowlist: ['localhost'] });
  assert.equal(byHost.hostname, 'localhost');
  // A different local IP is still blocked even with an allowlist present.
  await assert.rejects(() => assertUrlAllowed('http://192.168.1.99/', { allowlist: ['192.168.1.50'] }), SsrfError);
});

test('isBlockedIp classifies literals correctly', () => {
  for (const ip of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '172.16.5.5', '192.168.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd12::1', 'not-an-ip']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test('invalid URLs are rejected', async () => {
  await assert.rejects(() => assertUrlAllowed('not a url'), SsrfError);
  await assert.rejects(() => assertUrlAllowed('http://'), SsrfError);
});
