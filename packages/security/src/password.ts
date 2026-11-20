/**
 * Argon2id password hashing (spec §8B).
 *
 * Memory-hard hashing so that even a stolen database does not make offline
 * password cracking cheap. Parameters follow the OWASP recommendation for
 * Argon2id (64 MiB memory, 3 iterations, 4 lanes).
 */
import argon2 from 'argon2';

/**
 * Hash a plaintext password with Argon2id.
 * Returns the standard PHC-encoded string ($argon2id$v=19$...).
 * Parameters follow the OWASP recommendation for Argon2id
 * (64 MiB memory, 3 iterations, 4 lanes).
 */
export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new TypeError('hashPassword: password must be a non-empty string');
  }
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 65_536, // 64 MiB
    timeCost: 3,
    parallelism: 4,
    hashLength: 32,
  });
}

/**
 * Verify a plaintext password against a stored Argon2 hash.
 * Returns false (never throws) for malformed hashes or mismatches so callers
 * can use a single code path for "bad credentials".
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  if (typeof hash !== 'string' || typeof plain !== 'string' || plain.length === 0) {
    return false;
  }
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
