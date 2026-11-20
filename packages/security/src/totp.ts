/**
 * TOTP two-factor authentication, implemented from scratch on node:crypto
 * (spec §8B: mandatory TOTP 2FA, Google Authenticator / Authy compatible).
 *
 * - RFC 4226 HOTP + RFC 6238 TOTP, HMAC-SHA-1, 30-second step, 6 digits.
 * - Secrets are RFC 4648 base32 (the format authenticator apps expect).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

/** Encode a buffer as unpadded uppercase base32 (RFC 4648). */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** Decode a base32 string (padding/whitespace tolerated, case-insensitive). */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/u, '').replace(/[\s-]/gu, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`base32Decode: invalid character ${JSON.stringify(ch)}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generate a fresh random TOTP secret, base32-encoded (160 bits by default). */
export function generateTotpSecret(byteLength = 20): string {
  if (!Number.isInteger(byteLength) || byteLength < 10) {
    throw new RangeError('generateTotpSecret: byteLength must be an integer >= 10');
  }
  return base32Encode(randomBytes(byteLength));
}

/** RFC 4226 HOTP for an explicit counter value. */
export function hotpCode(secret: string, counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError('hotpCode: counter must be a non-negative safe integer');
  }
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(counterBuf).digest();
  // Dynamic truncation (RFC 4226 §5.3).
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/**
 * TOTP code for a point in time (defaults to now).
 * `time` may be a Date, epoch milliseconds, or epoch seconds (> 1e11 is
 * treated as milliseconds).
 */
export function totpCode(secret: string, time?: Date | number): string {
  const counter = Math.floor(toEpochSeconds(time) / STEP_SECONDS);
  return hotpCode(secret, counter);
}

/**
 * Verify a user-supplied TOTP code. Accepts codes from `window` steps on
 * either side of the current step (default ±1 step ≈ ±30 s of clock drift).
 * Comparison is constant-time; malformed input returns false.
 */
export function verifyTotp(
  secret: string,
  code: string,
  window = 1,
  time?: Date | number,
): boolean {
  if (typeof code !== 'string') return false;
  const normalized = code.replace(/\s/gu, '');
  if (!new RegExp(`^\\d{${DIGITS}}$`, 'u').test(normalized)) return false;
  if (!Number.isInteger(window) || window < 0) {
    throw new RangeError('verifyTotp: window must be a non-negative integer');
  }
  let currentCounter: number;
  try {
    currentCounter = Math.floor(toEpochSeconds(time) / STEP_SECONDS);
  } catch {
    return false;
  }
  const provided = Buffer.from(normalized, 'utf8');
  for (let drift = -window; drift <= window; drift += 1) {
    const counter = currentCounter + drift;
    if (counter < 0) continue;
    let expected: string;
    try {
      expected = hotpCode(secret, counter);
    } catch {
      return false;
    }
    if (timingSafeEqual(provided, Buffer.from(expected, 'utf8'))) {
      return true;
    }
  }
  return false;
}

function toEpochSeconds(time?: Date | number): number {
  if (time === undefined) return Math.floor(Date.now() / 1000);
  if (time instanceof Date) return Math.floor(time.getTime() / 1000);
  if (typeof time === 'number' && Number.isFinite(time)) {
    return Math.floor(time > 1e11 ? time / 1000 : time);
  }
  throw new TypeError('totp: time must be a Date or a finite number');
}
