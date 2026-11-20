/**
 * BullMQ queue adapter — STUB behind the same JobQueue interface from
 * @code-brothers/core that InMemoryQueue implements.
 *
 * The worker runs on InMemoryQueue today (local runs, tests, single-box
 * deployments). Moving to BullMQ later means installing the `bullmq`
 * package, pointing this adapter at Redis, and passing it as
 * `WorkerOptions.queue` — no call-site changes. Until then, actually
 * using the adapter fails loudly instead of silently dropping jobs.
 */
import type {
  DeadLetter,
  EnqueueOptions,
  JobQueue,
  QueueJob,
} from '@code-brothers/core';

export interface BullMqQueueOptions {
  /** BullMQ queue name. Default 'code-brothers'. */
  queueName?: string;
  /** Redis connection the BullMQ queue/worker pair would use. */
  connection?: {
    host?: string;
    port?: number;
    password?: string;
  };
}

const STUB_MESSAGE =
  'BullMqQueue is a stub: install the "bullmq" package and provide a Redis ' +
  'connection to use it. Use InMemoryQueue from @code-brothers/core for local runs.';

export class BullMqQueue<T = unknown> implements JobQueue<T> {
  constructor(private readonly options: BullMqQueueOptions = {}) {}

  get queueName(): string {
    return this.options.queueName ?? 'code-brothers';
  }

  async enqueue(
    _name: string,
    _data: T,
    _enqueueOptions?: EnqueueOptions,
  ): Promise<QueueJob<T>> {
    throw new Error(STUB_MESSAGE);
  }

  process(_handler: (job: QueueJob<T>) => Promise<void>): void {
    throw new Error(STUB_MESSAGE);
  }

  deadLetters(): DeadLetter<T>[] {
    return [];
  }

  pending(): number {
    return 0;
  }

  async waitForIdle(): Promise<void> {
    throw new Error(STUB_MESSAGE);
  }
}
