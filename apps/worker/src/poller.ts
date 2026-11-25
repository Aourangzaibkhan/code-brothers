/**
 * Poller — interval-based polling helper for trigger sources that have
 * no webhooks (spec §9 `polling_state`: Daraz & YouTube triggers). Each
 * cycle loads the stored cursor through the injected state store, hands
 * it to the poll function, and persists the cursor the poll returns —
 * so a restart resumes exactly where the last cycle stopped.
 */

export interface PollingStateStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/** In-memory PollingStateStore (local runs + tests). */
export class InMemoryPollingStateStore implements PollingStateStore {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}

export interface PollOutcome {
  /** The cursor to persist for the next cycle. */
  cursor: string;
  /** Items discovered this cycle (handed to onItems when non-empty). */
  items?: unknown[];
}

export interface PollerOptions {
  /** State-store key, e.g. 'daraz-orders' or 'youtube-comments'. */
  key: string;
  stateStore: PollingStateStore;
  /** One poll cycle: receives the stored cursor, returns the next one. */
  poll: (cursor: string | undefined) => Promise<PollOutcome>;
  /** Called with the items of a cycle when it discovered any. */
  onItems?: (items: unknown[], cursor: string) => Promise<void> | void;
  /** Default interval for start(). Default 60s. */
  intervalMs?: number;
}

export class Poller {
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: PollerOptions) {}

  /** The cursor currently stored for this poller (undefined before cycle 1). */
  async cursor(): Promise<string | undefined> {
    return this.options.stateStore.get(this.options.key);
  }

  /** Run exactly one poll cycle and persist the resulting cursor. */
  async tick(): Promise<PollOutcome> {
    const current = await this.options.stateStore.get(this.options.key);
    const outcome = await this.options.poll(current);
    await this.options.stateStore.set(this.options.key, outcome.cursor);
    if (outcome.items && outcome.items.length > 0) {
      await this.options.onItems?.(outcome.items, outcome.cursor);
    }
    return outcome;
  }

  /** Start polling on an interval. Same keepAlive rule as Scheduler.start. */
  start(intervalMs: number = this.options.intervalMs ?? 60_000, keepAlive = false): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    if (!keepAlive) this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
