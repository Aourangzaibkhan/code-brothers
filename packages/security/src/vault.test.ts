import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  decryptSecret,
  encryptSecret,
  generateMasterKey,
  getMasterKey,
  parseMasterKey,
  rotateRecord,
} from './vault.js';

const MASTER_A = parseMasterKey('a'.repeat(64));
const MASTER_B = parseMasterKey(randomBytes(32).toString('hex'));

test('parseMasterKey accepts exactly 64 hex chars and rejects weak/invalid keys', () => {
  assert.equal(parseMasterKey('0'.repeat(64)).length, 32);
  assert.equal(parseMasterKey(randomBytes(32).toString('hex')).length, 32);
  assert.throws(() => parseMasterKey('secret123'), /64 hex/u);
  assert.throws(() => parseMasterKey('z'.repeat(64)), /64 hex/u);
  assert.throws(() => parseMasterKey('a'.repeat(63)), /64 hex/u);
  assert.throws(() => parseMasterKey('a'.repeat(65)), /64 hex/u);
  assert.throws(() => parseMasterKey(''), /64 hex/u);
});

test('getMasterKey reads CB_MASTER_KEY from the environment', () => {
  const hex = randomBytes(32).toString('hex');
  assert.deepEqual(getMasterKey({ CB_MASTER_KEY: hex } as NodeJS.ProcessEnv), Buffer.from(hex, 'hex'));
  assert.throws(() => getMasterKey({} as NodeJS.ProcessEnv), /not set/u);
  assert.throws(() => getMasterKey({ CB_MASTER_KEY: 'weak' } as NodeJS.ProcessEnv), /64 hex/u);
});

test('generateMasterKey returns 64 hex chars that parse', () => {
  const hex = generateMasterKey();
  assert.match(hex, /^[0-9a-f]{64}$/u);
  assert.equal(parseMasterKey(hex).length, 32);
});

test('encrypt/decrypt round-trip', () => {
  const record = encryptSecret('shpat_live_key_1234567890', MASTER_A);
  assert.equal(record.algorithm, 'aes-256-gcm');
  assert.equal(record.version, 1);
  assert.equal(decryptSecret(record, MASTER_A), 'shpat_live_key_1234567890');
});

test('round-trip preserves unicode and empty strings', () => {
  for (const s of ['', 'パスワード 🔐', 'a'.repeat(10_000), 'line1\nline2']) {
    assert.equal(decryptSecret(encryptSecret(s, MASTER_A), MASTER_A), s);
  }
});

test('ciphertext does not contain the plaintext and records are unique (random DEK + IV)', () => {
  const plain = 'my-api-key-value';
  const a = encryptSecret(plain, MASTER_A);
  const b = encryptSecret(plain, MASTER_A);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.wrappedDek, b.wrappedDek);
  assert.notEqual(a.iv, b.iv);
  assert.ok(!Buffer.from(a.ciphertext, 'base64').toString('utf8').includes(plain));
});

test('decrypt with the wrong master key fails (GCM authentication)', () => {
  const record = encryptSecret('top-secret', MASTER_A);
  assert.throws(() => decryptSecret(record, MASTER_B));
});

test('tampered ciphertext is rejected', () => {
  const record = encryptSecret('top-secret', MASTER_A);
  const bytes = Buffer.from(record.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  assert.throws(() => decryptSecret({ ...record, ciphertext: bytes.toString('base64') }, MASTER_A));
});

test('tampered auth tag is rejected', () => {
  const record = encryptSecret('top-secret', MASTER_A);
  const tag = Buffer.from(record.authTag, 'base64');
  tag[0] ^= 0xff;
  assert.throws(() => decryptSecret({ ...record, authTag: tag.toString('base64') }, MASTER_A));
});

test('tampered wrapped DEK is rejected', () => {
  const record = encryptSecret('top-secret', MASTER_A);
  const dek = Buffer.from(record.wrappedDek, 'base64');
  dek[0] ^= 0xff;
  assert.throws(() => decryptSecret({ ...record, wrappedDek: dek.toString('base64') }, MASTER_A));
});

test('rotateRecord re-wraps the DEK: decrypts under the new key only, ciphertext unchanged', () => {
  const record = encryptSecret('rotate-me', MASTER_A);
  const rotated = rotateRecord(record, MASTER_B, MASTER_A);
  assert.equal(rotated.ciphertext, record.ciphertext);
  assert.equal(rotated.iv, record.iv);
  assert.equal(rotated.authTag, record.authTag);
  assert.notEqual(rotated.wrappedDek, record.wrappedDek);
  assert.equal(decryptSecret(rotated, MASTER_B), 'rotate-me');
  assert.throws(() => decryptSecret(rotated, MASTER_A));
  // Original record is untouched and still decrypts under the old key.
  assert.equal(decryptSecret(record, MASTER_A), 'rotate-me');
});

test('rotateRecord with a wrong old key throws', () => {
  const record = encryptSecret('rotate-me', MASTER_A);
  assert.throws(() => rotateRecord(record, MASTER_B, parseMasterKey(randomBytes(32).toString('hex'))));
});

test('encrypt/decrypt via CB_MASTER_KEY env var (default master key)', () => {
  const hex = randomBytes(32).toString('hex');
  const previous = process.env.CB_MASTER_KEY;
  process.env.CB_MASTER_KEY = hex;
  try {
    const record = encryptSecret('env-keyed-secret');
    assert.equal(decryptSecret(record), 'env-keyed-secret');
    const newKey = parseMasterKey(randomBytes(32).toString('hex'));
    const rotated = rotateRecord(record, newKey);
    assert.equal(decryptSecret(rotated, newKey), 'env-keyed-secret');
  } finally {
    if (previous === undefined) delete process.env.CB_MASTER_KEY;
    else process.env.CB_MASTER_KEY = previous;
  }
});
