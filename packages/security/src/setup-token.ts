/**
 * First-launch anti-hijack setup token (spec §8A).
 *
 * On first boot the server generates a single-use 32-byte cryptographic
 * token (printed only to the private container logs) which the owner uses to
 * claim the Owner account. The token expires after 15 minutes by default and
 * can be consumed exactly once. Only a SHA-256 hash of the token is kept at
 * rest — the raw token exists solely in the return value of
 * generateSetupToken() and in the log line the caller prints.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32; // spec §8A: 32-byte cryptographic setup token
const DEFAULT_TTL_MS = 15 * 60 * 1000; // spec §8A: expires in 15 minutes

interface StoredSetupToken {
  /** SHA-256 hex of the raw token — never the token itself. */
  hash: string;
  expiresAt: number;
  used: boolean;
}

/** Storage contract for setup tokens. */
export interface SetupTokenStore {
  save(record: StoredSetupToken): void;
  load(): StoredSetupToken | undefined;
  clear(): void;
}

/** Default in-memory store (one active setup token per process). */
export class MemorySetupTokenStore implements SetupTokenStore {
  private record: StoredSetupToken | undefined;

  save(record: StoredSetupToken): void {
    this.record = record;
  }

  load(): StoredSetupToken | undefined {
    return this.record;
  }

  clear(): void {
    this.record = undefined;
  }
}

export interface SetupTokenOptions {
  /** Time-to-live in ms. Default 15 minutes (spec §8A). */
  ttlMs?: number;
  /** Storage backend. Default MemorySetupTokenStore. */
  store?: SetupTokenStore;
  /** Clock override (tests). Default Date.now. */
  now?: () => number;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export class SetupTokenService {
  private readonly ttlMs: number;
  private readonly store: SetupTokenStore;
  private readonly now: () => number;

  constructor(options: SetupTokenOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.store = options.store ?? new MemorySetupTokenStore();
    this.now = options.now ?? (() => Date.now());
    if (this.ttlMs <= 0) {
      throw new RangeError('SetupTokenService: ttlMs must be positive');
    }
  }

  /**
   * Generate a fresh setup token. Any previously issued (unconsumed) token
   * is invalidated. The returned raw token is shown to the owner exactly
   * once; only its hash is stored.
   */
  generateSetupToken(): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.store.save({
      hash: hashToken(token).toString('hex'),
      expiresAt: this.now() + this.ttlMs,
      used: false,
    });
    return token;
  }

  /**
   * Verify and CONSUME a setup token. Returns true exactly once for a valid,
   * unexpired token; false for wrong, expired, already-used, or malformed
   * tokens. Hash comparison is constant-time.
   */
  verifySetupToken(token: string): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    const record = this.store.load();
    if (!record || record.used) return false;
    if (this.now() > record.expiresAt) {
      this.store.clear();
      return false;
    }
    const provided = hashToken(token);
    const expected = Buffer.from(record.hash, 'hex');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return false;
    }
    this.store.save({ ...record, used: true });
    return true;
  }

  /** True while an unconsumed, unexpired token exists (setup still pending). */
  hasActiveToken(): boolean {
    const record = this.store.load();
    return Boolean(record && !record.used && this.now() <= record.expiresAt);
  }

  /** Invalidate any outstanding token (e.g. after setup completes). */
  revoke(): void {
    this.store.clear();
  }
}

/** Shared default instance backing the module-level convenience functions. */
const defaultService = new SetupTokenService();

/** Generate a setup token on the shared default service. */
export function generateSetupToken(): string {
  return defaultService.generateSetupToken();
}

/** Verify + consume a setup token on the shared default service. */
export function verifySetupToken(token: string): boolean {
  return defaultService.verifySetupToken(token);
}

export { defaultService as defaultSetupTokenService };
