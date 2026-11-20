import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password.js';

test('hashPassword produces an Argon2id PHC string', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^\$argon2id\$v=19\$/u);
});

test('verifyPassword accepts the correct password', async () => {
  const hash = await hashPassword('S3cure!pass');
  assert.equal(await verifyPassword(hash, 'S3cure!pass'), true);
});

test('verifyPassword rejects a wrong password', async () => {
  const hash = await hashPassword('S3cure!pass');
  assert.equal(await verifyPassword(hash, 'S3cure!pass!'), false);
  assert.equal(await verifyPassword(hash, ''), false);
});

test('two hashes of the same password differ (random salt) but both verify', async () => {
  const [a, b] = await Promise.all([hashPassword('pw123456'), hashPassword('pw123456')]);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword(a, 'pw123456'), true);
  assert.equal(await verifyPassword(b, 'pw123456'), true);
});

test('verifyPassword returns false for a malformed hash instead of throwing', async () => {
  assert.equal(await verifyPassword('not-a-hash', 'pw'), false);
  assert.equal(await verifyPassword('', 'pw'), false);
  assert.equal(await verifyPassword('$argon2id$v=19$garbage', 'pw'), false);
});

test('hashPassword rejects empty input', async () => {
  await assert.rejects(() => hashPassword(''), TypeError);
});
