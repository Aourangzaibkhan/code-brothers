import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryQueue, type QueueJob } from './queue.js';

const noSleep = async () => {};

describe('InMemoryQueue', () => {
  it('processes jobs in FIFO order', async () => {
    const queue = new InMemoryQueue<string>({ sleep: noSleep });
    const seen: string[] = [];
    await queue.enqueue('job', 'a');
    await queue.enqueue('job', 'b');
    await queue.enqueue('job', 'c');
    queue.process(async (job) => {
      seen.push(job.data);
    });
    await queue.waitForIdle();
    assert.deepEqual(seen, ['a', 'b', 'c']);
    assert.equal(queue.pending(), 0);
    assert.equal(queue.deadLetters().length, 0);
  });

  it('retries a failing job until it succeeds', async () => {
    const queue = new InMemoryQueue<string>({ sleep: noSleep });
    let calls = 0;
    queue.process(async () => {
      calls += 1;
      if (calls < 3) throw new Error('flaky');
    });
    await queue.enqueue('job', 'x', { maxAttempts: 3, backoffMs: 1 });
    await queue.waitForIdle();
    assert.equal(calls, 3);
    assert.equal(queue.deadLetters().length, 0);
  });

  it('moves a job to the dead-letter list after exhausting attempts', async () => {
    const queue = new InMemoryQueue<string>({ sleep: noSleep });
    let calls = 0;
    queue.process(async () => {
      calls += 1;
      throw new Error('always fails');
    });
    const job = await queue.enqueue('job', 'x', {
      maxAttempts: 2,
      backoffMs: 1,
    });
    await queue.waitForIdle();
    assert.equal(calls, 2);
    const dead = queue.deadLetters();
    assert.equal(dead.length, 1);
    assert.equal(dead[0]?.job.id, job.id);
    assert.equal(dead[0]?.job.attempts, 2);
    assert.match(dead[0]?.error ?? '', /always fails/);
  });

  it('applies backoff between retries via the injected sleep', async () => {
    const sleeps: number[] = [];
    const queue = new InMemoryQueue<string>({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    queue.process(async () => {
      throw new Error('nope');
    });
    await queue.enqueue('job', 'x', { maxAttempts: 3, backoffMs: 100 });
    await queue.waitForIdle();
    assert.deepEqual(sleeps, [100, 200]);
  });

  it('waitForIdle resolves immediately on an empty queue', async () => {
    const queue = new InMemoryQueue({ sleep: noSleep });
    await queue.waitForIdle();
    const job: QueueJob = await queue.enqueue('job', { ok: true });
    assert.equal(job.attempts, 0);
    assert.equal(queue.pending(), 1);
  });
});
