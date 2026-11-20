import { randomUUID } from 'node:crypto';

/**
 * Job queue abstraction. The worker app will plug BullMQ in behind this
 * interface later; the in-memory implementation below provides the same
 * semantics (FIFO processing, retry with backoff, dead-letter list) for
 * local runs and tests.
 */

export interface QueueJob<T = unknown> {
  id: string;
  name: string;
  data: T;
  /** Attempts made so far (incremented before each try). */
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  enqueuedAt: string;
}

export interface DeadLetter<T = unknown> {
  job: QueueJob<T>;
  error: string;
  failedAt: string;
}

export interface EnqueueOptions {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Base retry delay in ms (multiplied by attempt number). Default 1000. */
  backoffMs?: number;
}

export interface JobQueue<T = unknown> {
  enqueue(name: string, data: T, options?: EnqueueOptions): Promise<QueueJob<T>>;
  /** Register the handler and start processing. */
  process(handler: (job: QueueJob<T>) => Promise<void>): void;
  deadLetters(): DeadLetter<T>[];
  /** Jobs waiting to be processed (not counting the active one). */
  pending(): number;
  /** Resolves when the queue is empty and no job is active. */
  waitForIdle(): Promise<void>;
}

export interface InMemoryQueueOptions {
  /** Injectable sleep so tests never really wait. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class InMemoryQueue<T = unknown> implements JobQueue<T> {
  private readonly waiting: QueueJob<T>[] = [];
  private readonly dead: DeadLetter<T>[] = [];
  private handler: ((job: QueueJob<T>) => Promise<void>) | null = null;
  private active = false;
  private pumping = false;
  private idleWaiters: Array<() => void> = [];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: InMemoryQueueOptions = {}) {
    this.sleep = options.sleep ?? realSleep;
  }

  async enqueue(
    name: string,
    data: T,
    options: EnqueueOptions = {},
  ): Promise<QueueJob<T>> {
    const job: QueueJob<T> = {
      id: randomUUID(),
      name,
      data,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      backoffMs: options.backoffMs ?? 1000,
      enqueuedAt: new Date().toISOString(),
    };
    this.waiting.push(job);
    this.pump();
    return job;
  }

  process(handler: (job: QueueJob<T>) => Promise<void>): void {
    this.handler = handler;
    this.pump();
  }

  deadLetters(): DeadLetter<T>[] {
    return [...this.dead];
  }

  pending(): number {
    return this.waiting.length;
  }

  waitForIdle(): Promise<void> {
    if (!this.active && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private notifyIdle(): void {
    if (this.active || this.waiting.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private pump(): void {
    if (this.pumping || !this.handler) return;
    this.pumping = true;
    void (async () => {
      try {
        while (this.handler && this.waiting.length > 0) {
          const job = this.waiting.shift()!;
          this.active = true;
          await this.runJob(job);
          this.active = false;
          this.notifyIdle();
        }
      } finally {
        this.pumping = false;
        this.notifyIdle();
      }
    })();
  }

  private async runJob(job: QueueJob<T>): Promise<void> {
    const handler = this.handler;
    if (!handler) return;
    for (;;) {
      job.attempts += 1;
      try {
        await handler(job);
        return;
      } catch (err) {
        if (job.attempts >= job.maxAttempts) {
          this.dead.push({
            job,
            error: err instanceof Error ? err.message : String(err),
            failedAt: new Date().toISOString(),
          });
          return;
        }
        await this.sleep(job.backoffMs * job.attempts);
      }
    }
  }
}
