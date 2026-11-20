import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SsrfError,
  createSsrfGuard,
  isPrivateIp,
} from './ssrf.js';

describe('isPrivateIp', () => {
  it('flags private, loopback and link-local IPv4 ranges', () => {
    for (const ip of [
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '0.0.0.0',
      '169.254.169.254',
      '100.64.0.1',
    ]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
  });

  it('allows public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '1.1.1.1']) {
      assert.equal(isPrivateIp(ip), false, ip);
    }
  });

  it('flags IPv6 loopback, link-local and unique-local', () => {
    assert.equal(isPrivateIp('::1'), true);
    assert.equal(isPrivateIp('fe80::1'), true);
    assert.equal(isPrivateIp('fd00::1'), true);
    assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateIp('2606:4700:4700::1111'), false);
  });
});

describe('createSsrfGuard', () => {
  it('blocks non-http schemes', async () => {
    const guard = createSsrfGuard();
    await assert.rejects(() => guard(new URL('file:///etc/passwd')), SsrfError);
    await assert.rejects(() => guard(new URL('ftp://example.com/x')), SsrfError);
  });

  it('blocks literal private IPs and localhost without any DNS', async () => {
    const guard = createSsrfGuard();
    await assert.rejects(() => guard(new URL('http://127.0.0.1:8080/')), SsrfError);
    await assert.rejects(() => guard(new URL('http://169.254.169.254/latest/meta-data')), SsrfError);
    await assert.rejects(() => guard(new URL('http://192.168.0.10/')), SsrfError);
    await assert.rejects(() => guard(new URL('http://localhost:3000/')), SsrfError);
  });

  it('allows literal public IPs', async () => {
    const guard = createSsrfGuard();
    await guard(new URL('https://93.184.216.34/'));
  });

  it('blocks hostnames that resolve to private IPs', async () => {
    const guard = createSsrfGuard({
      lookup: async () => ['10.1.2.3'],
    });
    await assert.rejects(() => guard(new URL('https://evil.example.com/')), SsrfError);
  });

  it('allows hostnames that resolve only to public IPs', async () => {
    const guard = createSsrfGuard({
      lookup: async () => ['93.184.216.34', '8.8.8.8'],
    });
    await guard(new URL('https://example.com/'));
  });

  it('allowPrivate permits loopback (dev mode)', async () => {
    const guard = createSsrfGuard({ allowPrivate: true });
    await guard(new URL('http://127.0.0.1:9999/'));
  });
});
