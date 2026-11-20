/**
 * Progressive brute-force login shield (spec §8B).
 *
 * Default policy: 5 failed attempts within a 10-minute window lock the key
 * (an account id, an IP, or "ip:account") for 15 minutes. A successful login
 * clears the failure history. The store sits behind a small interface so the
 * in-memory implementation can be swapped for the Redis-backed one used in
 * production without changing call sites.
 */

export interface ThrottleEntry {
  /** Timestamps (ms) of recent failures inside the sliding window. */
  failures: number[];
  /** Epoch ms until which the key is locked, if a lock is active. */
  lockedUntil?: number;
}

/** Storage backend contract for LoginThrottle. */
export interface LoginThrottleStore {
  get(key: string): ThrottleEntry | undefined;
  set(key: string, entry: ThrottleEntry): void;
  delete(key: string): void;
}

/** Default in-memory store. */
export class MemoryThrottleStore implements LoginThrottleStore {
  private readonly map = new Map<string, ThrottleEntry>();

  get(key: string): ThrottleEntry | undefined {
    return this.map.get(key);
  }

  set(key: string, entry: ThrottleEntry): void {
    this.map.set(key, entry);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  /** Number of tracked keys (diagnostics/tests). */
  get size(): number {
    return this.map.size;
  }
}

export interface LoginThrottleOptions {
  /** Failures inside the window that trigger a lock. Default 5. */
  maxFailures?: number;
  /** Sliding failure window in ms. Default 10 minutes. */
  windowMs?: number;
  /** Lock duration in ms. Default 15 minutes. */
  lockMs?: number;
  /** Storage backend. Default MemoryThrottleStore. */
  store?: LoginThrottleStore;
  /** Clock override (tests). Default Date.now. */
  now?: () => number;
}

export interface ThrottleStatus {
  locked: boolean;
  /** Failures currently counted inside the window. */
  failureCount: number;
  /** Attempts left before a lock is triggered. */
  remainingAttempts: number;
  /** Epoch ms when the lock ends (only when locked). */
  lockedUntil?: number;
  /** Ms remaining on the lock (only when locked). */
  retryAfterMs?: number;
}

export class LoginThrottle {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly store: LoginThrottleStore;
  private readonly now: () => number;

  constructor(options: LoginThrottleOptions = {}) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 10 * 60 * 1000;
    this.lockMs = options.lockMs ?? 15 * 60 * 1000;
    this.store = options.store ?? new MemoryThrottleStore();
    this.now = options.now ?? (() => Date.now());
    if (!Number.isInteger(this.maxFailures) || this.maxFailures < 1) {
      throw new RangeError('LoginThrottle: maxFailures must be a positive integer');
    }
    if (this.windowMs <= 0 || this.lockMs <= 0) {
      throw new RangeError('LoginThrottle: windowMs and lockMs must be positive');
    }
  }

  /**
   * Record a failed login attempt for `key`. Returns the resulting status —
   * when the failure threshold is reached the key becomes locked.
   * Failures recorded while already locked do not extend the lock.
   */
  recordFailure(key: string): ThrottleStatus {
    const now = this.now();
    const entry = this.prunedEntry(key, now);
    if (entry?.lockedUntil && entry.lockedUntil > now) {
      return this.statusOf(entry, now);
    }
    const failures = [...(entry?.failures ?? []), now];
    const next: ThrottleEntry = { failures };
    if (failures.length >= this.maxFailures) {
      next.lockedUntil = now + this.lockMs;
      next.failures = [];
    }
    this.store.set(key, next);
    return this.statusOf(next, now);
  }

  /** Record a successful login: clears failures and any expired/active lock bookkeeping for `key`. */
  recordSuccess(key: string): void {
    this.store.delete(key);
  }

  /** True while `key` is inside an active lock period. */
  isLocked(key: string): boolean {
    const now = this.now();
    const entry = this.prunedEntry(key, now);
    return Boolean(entry?.lockedUntil && entry.lockedUntil > now);
  }

  /** Full status snapshot for `key`. */
  getStatus(key: string): ThrottleStatus {
    const now = this.now();
    const entry = this.prunedEntry(key, now);
    if (!entry) {
      return { locked: false, failureCount: 0, remainingAttempts: this.maxFailures };
    }
    return this.statusOf(entry, now);
  }

  /** Drop failures that have aged out of the window and expire finished locks. */
  private prunedEntry(key: string, now: number): ThrottleEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    const failures = entry.failures.filter((t) => now - t < this.windowMs);
    const lockedUntil = entry.lockedUntil && entry.lockedUntil > now ? entry.lockedUntil : undefined;
    if (failures.length === 0 && lockedUntil === undefined) {
      this.store.delete(key);
      return undefined;
    }
    const pruned: ThrottleEntry = { failures, lockedUntil };
    if (failures.length !== entry.failures.length || lockedUntil !== entry.lockedUntil) {
      this.store.set(key, pruned);
    }
    return pruned;
  }

  private statusOf(entry: ThrottleEntry, now: number): ThrottleStatus {
    const locked = Boolean(entry.lockedUntil && entry.lockedUntil > now);
    const failureCount = entry.failures.length;
    return {
      locked,
      failureCount,
      remainingAttempts: locked ? 0 : Math.max(0, this.maxFailures - failureCount),
      ...(locked
        ? { lockedUntil: entry.lockedUntil, retryAfterMs: (entry.lockedUntil as number) - now }
        : {}),
    };
  }
}
