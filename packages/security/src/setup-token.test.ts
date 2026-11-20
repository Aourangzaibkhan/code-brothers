import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SetupTokenService,
  generateSetupToken,
  verifySetupToken,
} from './setup-token.js';

function fakeClock(start = 5_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

test('a generated token verifies once and only once (single-use)', () => {
  const svc = new SetupTokenService();
  const token = svc.generateSetupToken();
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 40); // 32 random bytes, base64url
  assert.equal(svc.verifySetupToken(token), true);
  assert.equal(svc.verifySetupToken(token), false); // replay rejected
});

test('a wrong token is rejected and does not consume the real one', () => {
  const svc = new SetupTokenService();
  const token = svc.generateSetupToken();
  assert.equal(svc.verifySetupToken('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
  assert.equal(svc.verifySetupToken(''), false);
  assert.equal(svc.verifySetupToken(token), true);
});

test('tokens are unique per generation and a new token invalidates the old', () => {
  const svc = new SetupTokenService();
  const first = svc.generateSetupToken();
  const second = svc.generateSetupToken();
  assert.notEqual(first, second);
  assert.equal(svc.verifySetupToken(first), false);
  assert.equal(svc.verifySetupToken(second), true);
});

test('token expires after the default 15 minutes (spec §8A)', () => {
  const clock = fakeClock();
  const svc = new SetupTokenService({ now: clock.now });
  const token = svc.generateSetupToken();
  clock.advance(14 * 60 * 1000);
  assert.equal(svc.hasActiveToken(), true);
  clock.advance(60 * 1000 + 1);
  assert.equal(svc.hasActiveToken(), false);
  assert.equal(svc.verifySetupToken(token), false);
});

test('custom TTL is honored', () => {
  const clock = fakeClock();
  const svc = new SetupTokenService({ ttlMs: 5_000, now: clock.now });
  const token = svc.generateSetupToken();
  clock.advance(4_999);
  assert.equal(svc.verifySetupToken(token), true);
  const token2 = svc.generateSetupToken();
  clock.advance(5_001);
  assert.equal(svc.verifySetupToken(token2), false);
});

test('revoke() invalidates an outstanding token', () => {
  const svc = new SetupTokenService();
  const token = svc.generateSetupToken();
  svc.revoke();
  assert.equal(svc.hasActiveToken(), false);
  assert.equal(svc.verifySetupToken(token), false);
});

test('verify with no token issued returns false', () => {
  const svc = new SetupTokenService();
  assert.equal(svc.hasActiveToken(), false);
  assert.equal(svc.verifySetupToken('anything'), false);
});

test('only the hash is kept at rest (raw token is not stored)', () => {
  const records: Array<{ hash: string; expiresAt: number; used: boolean }> = [];
  const store = {
    save: (r: { hash: string; expiresAt: number; used: boolean }) => { records.push(r); },
    load: () => records[records.length - 1],
    clear: () => { records.length = 0; },
  };
  const svc = new SetupTokenService({ store });
  const token = svc.generateSetupToken();
  const stored = records[records.length - 1];
  assert.match(stored.hash, /^[0-9a-f]{64}$/u); // SHA-256 hex
  assert.notEqual(stored.hash, token);
  assert.ok(!JSON.stringify(stored).includes(token));
  assert.equal(svc.verifySetupToken(token), true);
});

test('module-level generate/verify functions work via the default service', () => {
  const token = generateSetupToken();
  assert.equal(verifySetupToken(token), true);
  assert.equal(verifySetupToken(token), false);
});
