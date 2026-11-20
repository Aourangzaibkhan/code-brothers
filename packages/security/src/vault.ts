/**
 * AES-256-GCM envelope-encryption credential vault (spec §8C).
 *
 * Every secret is encrypted with its own random Data Encryption Key (DEK).
 * The DEK is itself encrypted ("wrapped") with the Master Key, which comes
 * from the CB_MASTER_KEY environment variable (64 hex chars = 256 bits) and
 * never touches the database. Rotating the master key only re-wraps DEKs —
 * the stored ciphertexts do not change (see rotateRecord).
 *
 * All binary fields in an EncryptedSecret record are base64 strings so the
 * record maps 1:1 onto the `credentials` table columns (spec §9: ciphertext,
 * IVs, DEKs, rotation metadata).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const VAULT_ALGORITHM = 'aes-256-gcm';
const RECORD_VERSION = 1;
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce size

/** A stored, envelope-encrypted secret. All binary values are base64. */
export interface EncryptedSecret {
  version: number;
  algorithm: typeof VAULT_ALGORITHM;
  /** Base64 ciphertext of the plaintext secret, encrypted under the DEK. */
  ciphertext: string;
  /** Base64 IV used for the data encryption. */
  iv: string;
  /** Base64 GCM auth tag for the data encryption. */
  authTag: string;
  /** Base64 DEK, encrypted ("wrapped") under the master key. */
  wrappedDek: string;
  /** Base64 IV used for the DEK wrap. */
  wrapIv: string;
  /** Base64 GCM auth tag for the DEK wrap. */
  wrapAuthTag: string;
}

/**
 * Parse and validate a master key: exactly 64 hex characters (256 bits).
 * Throws on anything else — the startup validator must refuse weak keys
 * (spec §8A).
 */
export function parseMasterKey(hex: string): Buffer {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(hex)) {
    throw new Error(
      'Invalid master key: expected 64 hex characters (256 bits). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(hex, 'hex');
}

/** Read the master key from the CB_MASTER_KEY environment variable. */
export function getMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.CB_MASTER_KEY;
  if (!raw) {
    throw new Error('CB_MASTER_KEY environment variable is not set');
  }
  return parseMasterKey(raw);
}

/** Generate a fresh random master key as 64 hex chars (for first-boot setup). */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString('hex');
}

function assertMasterKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error('Master key must be a 32-byte Buffer (see parseMasterKey)');
  }
}

function gcmEncrypt(key: Buffer, plaintext: Buffer): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(VAULT_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function gcmDecrypt(key: Buffer, ciphertext: Buffer, iv: Buffer, authTag: Buffer): Buffer {
  const decipher = createDecipheriv(VAULT_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function wrapDek(dek: Buffer, masterKey: Buffer): Pick<EncryptedSecret, 'wrappedDek' | 'wrapIv' | 'wrapAuthTag'> {
  const { ciphertext, iv, authTag } = gcmEncrypt(masterKey, dek);
  return {
    wrappedDek: ciphertext.toString('base64'),
    wrapIv: iv.toString('base64'),
    wrapAuthTag: authTag.toString('base64'),
  };
}

function unwrapDek(record: EncryptedSecret, masterKey: Buffer): Buffer {
  const dek = gcmDecrypt(
    masterKey,
    Buffer.from(record.wrappedDek, 'base64'),
    Buffer.from(record.wrapIv, 'base64'),
    Buffer.from(record.wrapAuthTag, 'base64'),
  );
  if (dek.length !== KEY_BYTES) {
    throw new Error('Vault: unwrapped DEK has an unexpected length — record is corrupt');
  }
  return dek;
}

/**
 * Encrypt a plaintext secret into a storable envelope record.
 * `masterKey` defaults to the CB_MASTER_KEY environment variable.
 */
export function encryptSecret(plain: string, masterKey: Buffer = getMasterKey()): EncryptedSecret {
  if (typeof plain !== 'string') {
    throw new TypeError('encryptSecret: plain must be a string');
  }
  assertMasterKey(masterKey);
  const dek = randomBytes(KEY_BYTES);
  try {
    const { ciphertext, iv, authTag } = gcmEncrypt(dek, Buffer.from(plain, 'utf8'));
    return {
      version: RECORD_VERSION,
      algorithm: VAULT_ALGORITHM,
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ...wrapDek(dek, masterKey),
    };
  } finally {
    dek.fill(0);
  }
}

/**
 * Decrypt a stored envelope record back to the plaintext secret.
 * Throws if the record was tampered with or the master key is wrong
 * (GCM authentication failure) — it never returns partial plaintext.
 */
export function decryptSecret(record: EncryptedSecret, masterKey: Buffer = getMasterKey()): string {
  assertMasterKey(masterKey);
  if (!record || record.algorithm !== VAULT_ALGORITHM) {
    throw new Error(`Vault: unsupported record algorithm ${JSON.stringify(record?.algorithm)}`);
  }
  const dek = unwrapDek(record, masterKey);
  try {
    const plain = gcmDecrypt(
      dek,
      Buffer.from(record.ciphertext, 'base64'),
      Buffer.from(record.iv, 'base64'),
      Buffer.from(record.authTag, 'base64'),
    );
    return plain.toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/**
 * Re-wrap a record's DEK under a NEW master key (master-key rotation,
 * spec §8C). The data ciphertext, IV and auth tag are untouched — only the
 * wrapped DEK changes. `oldMasterKey` defaults to CB_MASTER_KEY from the
 * environment. Returns a new record; the input is not mutated.
 */
export function rotateRecord(
  record: EncryptedSecret,
  newMasterKey: Buffer,
  oldMasterKey: Buffer = getMasterKey(),
): EncryptedSecret {
  assertMasterKey(newMasterKey);
  assertMasterKey(oldMasterKey);
  const dek = unwrapDek(record, oldMasterKey);
  try {
    return { ...record, ...wrapDek(dek, newMasterKey) };
  } finally {
    dek.fill(0);
  }
}
