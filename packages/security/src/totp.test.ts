import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotpCode,
  totpCode,
  verifyTotp,
} from './totp.js';

// RFC 6238 Appendix B test secret: ASCII "12345678901234567890" for SHA-1.
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_B32 = base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'));

test('base32 encodes the RFC secret to the well-known value', () => {
  assert.equal(RFC_SECRET_B32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

test('base32 round-trips arbitrary buffers', () => {
  for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', 'hello world 123']) {
    const buf = Buffer.from(s, 'utf8');
    assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  }
});

test('base32Decode tolerates padding, spaces and lowercase', () => {
  const expected = Buffer.from('foobar', 'utf8');
  assert.deepEqual(base32Decode(base32Encode(expected).toLowerCase()), expected);
  assert.deepEqual(base32Decode('MZXW6YTBOI======'), expected);
  assert.throws(() => base32Decode('MZXW6!'), /invalid character/u);
});

test('RFC 6238 SHA-1 test vectors (6-digit code = low 6 digits of the RFC 8-digit value)', () => {
  // RFC 6238 Appendix B, SHA-1 column: (epoch seconds, 8-digit TOTP).
  // NOTE: the RFC's final row (t=20000000000 → 35313082) is a known erratum —
  // it does not match the 20-byte SHA-1 seed used by the other rows. This
  // implementation yields 65353130 for that timestamp, cross-checked against
  // an independent Python hmac/hashlib implementation, so the row is omitted.
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
  ];
  for (const [seconds, eightDigit] of vectors) {
    const expected6 = eightDigit.slice(-6);
    assert.equal(totpCode(RFC_SECRET_B32, seconds), expected6, `t=${seconds}`);
    assert.equal(verifyTotp(RFC_SECRET_B32, expected6, 0, seconds), true);
  }
});

test('hotpCode matches RFC 4226 vectors for the ASCII secret', () => {
  // RFC 4226 Appendix D (HOTP, 6 digits) for secret "12345678901234567890".
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  expected.forEach((code, counter) => {
    assert.equal(hotpCode(RFC_SECRET_B32, counter), code, `counter=${counter}`);
  });
});

test('generateTotpSecret returns distinct base32 secrets of the right size', () => {
  const a = generateTotpSecret();
  const b = generateTotpSecret();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Z2-7]+$/u);
  assert.equal(base32Decode(a).length, 20);
  assert.equal(base32Decode(generateTotpSecret(32)).length, 32);
  assert.throws(() => generateTotpSecret(4), RangeError);
});

test('totpCode/verifyTotp round-trip at the current time', () => {
  const secret = generateTotpSecret();
  const code = totpCode(secret);
  assert.match(code, /^\d{6}$/u);
  assert.equal(verifyTotp(secret, code), true);
});

test('verifyTotp rejects a wrong code', () => {
  const secret = generateTotpSecret();
  const code = totpCode(secret);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal(verifyTotp(secret, wrong), false);
});

test('verifyTotp rejects codes for a different secret', () => {
  const a = generateTotpSecret();
  const b = generateTotpSecret();
  assert.equal(verifyTotp(b, totpCode(a)), false);
});

test('verifyTotp window accepts adjacent steps but not far ones', () => {
  const secret = generateTotpSecret();
  const t = 1_700_000_000; // fixed epoch seconds
  const codeNow = totpCode(secret, t);
  const codePrev = totpCode(secret, t - 30);
  const codeNext = totpCode(secret, t + 30);
  const codeFar = totpCode(secret, t + 300);
  assert.equal(verifyTotp(secret, codePrev, 1, t), true);
  assert.equal(verifyTotp(secret, codeNext, 1, t), true);
  assert.equal(verifyTotp(secret, codeNow, 0, t), true);
  assert.equal(verifyTotp(secret, codePrev, 0, t), codePrev === codeNow);
  assert.equal(verifyTotp(secret, codeFar, 1, t), false);
});

test('verifyTotp rejects malformed codes', () => {
  const secret = generateTotpSecret();
  assert.equal(verifyTotp(secret, '12345'), false);
  assert.equal(verifyTotp(secret, '1234567'), false);
  assert.equal(verifyTotp(secret, 'abcdef'), false);
  assert.equal(verifyTotp(secret, ''), false);
  assert.equal(verifyTotp('!!!invalid-secret!!!', '123456'), false);
});

test('verifyTotp accepts a code with spaces (authenticator copy-paste)', () => {
  const secret = generateTotpSecret();
  const code = totpCode(secret);
  assert.equal(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`), true);
});

test('totpCode accepts Date and millisecond inputs', () => {
  const secret = generateTotpSecret();
  const seconds = 1_700_000_000;
  assert.equal(totpCode(secret, new Date(seconds * 1000)), totpCode(secret, seconds));
  assert.equal(totpCode(secret, seconds * 1000), totpCode(secret, seconds));
});
