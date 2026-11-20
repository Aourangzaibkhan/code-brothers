/**
 * AntiBanQueue — outbound send pacing for WhatsApp numbers.
 *
 * WhatsApp bans numbers that blast messages like a machine. This queue
 * serializes sends per sender key (usually a phone number id / number) and
 * enforces:
 *  - a per-key daily cap (per UTC day),
 *  - a minimum interval between consecutive sends,
 *  - a random jitter on top of the interval so sends look human-paced.
 *
 * Clock, sleep and randomness are injectable so tests (and the workflow
 * engine) never wait in real time.
 */
export interface AntiBanOptions {
  /** Max sends per key per UTC day. Default 250. */
  dailyCap?: number;
  /** Minimum milliseconds between sends for the same key. Default 1500. */
  minIntervalMs?: number;
  /** Extra random delay, uniformly in [0, maxJitterMs). Default 1500. */
  maxJitterMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class AntiBanCapError extends Error {
  readonly key: string;
  readonly dailyCap: number;
  readonly dayCount: number;
  constructor(key: string, dailyCap: number, dayCount: number) {
    super(
      `Anti-ban daily cap reached for "${key}": ${dayCount}/${dailyCap} sends today`,
    );
    this.name = 'AntiBanCapError';
    this.key = key;
    this.dailyCap = dailyCap;
    this.dayCount = dayCount;
  }
}

interface KeyState {
  day: string;
  count: number;
  lastSentAt: number | undefined;
}

function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export class AntiBanQueue {
  private readonly dailyCap: number;
  private readonly minIntervalMs: number;
  private readonly maxJitterMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly states = new Map<string, KeyState>();

  constructor(options: AntiBanOptions = {}) {
    this.dailyCap = options.dailyCap ?? 250;
    this.minIntervalMs = options.minIntervalMs ?? 1500;
    this.maxJitterMs = options.maxJitterMs ?? 1500;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? (() => Math.random());
  }

  private stateFor(key: string): KeyState {
    const day = utcDay(this.now());
    let state = this.states.get(key);
    if (!state || state.day !== day) {
      state = { day, count: 0, lastSentAt: state?.lastSentAt };
      this.states.set(key, state);
    }
    return state;
  }

  /** Sends already performed today (UTC) for this key. */
  getDailyCount(key: string): number {
    return this.stateFor(key).count;
  }

  /**
   * Enqueue a send task for `key`. Tasks for the same key run strictly one
   * at a time, paced by the anti-ban rules. Rejects with AntiBanCapError
   * once the daily cap is hit — the task is NOT executed in that case.
   */
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.runPaced(key, task));
    // Keep the chain alive even when a task rejects.
    this.tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async runPaced<T>(key: string, task: () => Promise<T>): Promise<T> {
    const state = this.stateFor(key);
    if (state.count >= this.dailyCap) {
      throw new AntiBanCapError(key, this.dailyCap, state.count);
    }
    if (state.lastSentAt !== undefined) {
      const jitter = Math.floor(this.random() * this.maxJitterMs);
      const earliest = state.lastSentAt + this.minIntervalMs + jitter;
      const wait = earliest - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    const result = await task();
    const after = this.stateFor(key);
    after.count += 1;
    after.lastSentAt = this.now();
    return result;
  }
}
