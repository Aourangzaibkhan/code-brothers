import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AntiBanCapError, AntiBanQueue } from './anti-ban.js';

function fakeClock(start = Date.UTC(2026, 0, 15, 10, 0, 0)) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
    time: () => t,
  };
}

test('enforces minimum interval plus jitter between sends', async () => {
  const clock = fakeClock();
  const queue = new AntiBanQueue({
    dailyCap: 100,
    minIntervalMs: 1000,
    maxJitterMs: 1000,
    random: () => 0.5, // jitter = 500ms
    now: clock.now,
    sleep: clock.sleep,
  });
  const executedAt: number[] = [];
  const task = async () => {
    executedAt.push(clock.time());
    return 'ok';
  };
  await queue.enqueue('num1', task);
  await queue.enqueue('num1', task);
  await queue.enqueue('num1', task);
  // First send immediate; each later send waits 1000 + 500 = 1500ms.
  assert.deepEqual(clock.sleeps, [1500, 1500]);
  assert.equal(executedAt[1]! - executedAt[0]!, 1500);
  assert.equal(executedAt[2]! - executedAt[1]!, 1500);
  assert.equal(queue.getDailyCount('num1'), 3);
});

test('no wait when enough real time already passed', async () => {
  const clock = fakeClock();
  const queue = new AntiBanQueue({
    minIntervalMs: 1000,
    maxJitterMs: 0,
    now: clock.now,
    sleep: clock.sleep,
  });
  await queue.enqueue('n', async () => 1);
  clock.advance(5000);
  await queue.enqueue('n', async () => 2);
  assert.deepEqual(clock.sleeps, []);
});

test('daily cap rejects without running the task', async () => {
  const clock = fakeClock();
  const queue = new AntiBanQueue({
    dailyCap: 2,
    minIntervalMs: 0,
    maxJitterMs: 0,
    now: clock.now,
    sleep: clock.sleep,
  });
  let runs = 0;
  const task = async () => {
    runs += 1;
  };
  await queue.enqueue('n', task);
  await queue.enqueue('n', task);
  await assert.rejects(queue.enqueue('n', task), (err: unknown) => {
    assert.ok(err instanceof AntiBanCapError);
    assert.equal(err.dailyCap, 2);
    assert.equal(err.dayCount, 2);
    return true;
  });
  assert.equal(runs, 2);
});

test('counter resets on the next UTC day', async () => {
  const clock = fakeClock(Date.UTC(2026, 0, 15, 23, 59, 0));
  const queue = new AntiBanQueue({
    dailyCap: 1,
    minIntervalMs: 0,
    maxJitterMs: 0,
    now: clock.now,
    sleep: clock.sleep,
  });
  await queue.enqueue('n', async () => 'a');
  await assert.rejects(queue.enqueue('n', async () => 'b'), AntiBanCapError);
  clock.advance(2 * 60 * 1000); // 00:01 next day
  assert.equal(await queue.enqueue('n', async () => 'c'), 'c');
  assert.equal(queue.getDailyCount('n'), 1);
});

test('caps and pacing are per key', async () => {
  const clock = fakeClock();
  const queue = new AntiBanQueue({
    dailyCap: 1,
    minIntervalMs: 60_000,
    maxJitterMs: 0,
    now: clock.now,
    sleep: clock.sleep,
  });
  await queue.enqueue('alice', async () => 1);
  // A different key is unaffected by alice's cap/interval.
  await queue.enqueue('bob', async () => 2);
  assert.deepEqual(clock.sleeps, []);
  await assert.rejects(queue.enqueue('alice', async () => 3), AntiBanCapError);
});

test('tasks for the same key run strictly sequentially', async () => {
  const clock = fakeClock();
  const queue = new AntiBanQueue({
    minIntervalMs: 0,
    maxJitterMs: 0,
    now: clock.now,
    sleep: clock.sleep,
  });
  const order: string[] = [];
  const make = (label: string, delayMs: number) => async () => {
    order.push(`start:${label}`);
    await clock.sleep(delayMs);
    order.push(`end:${label}`);
  };
  await Promise.all([
    queue.enqueue('k', make('a', 30)),
    queue.enqueue('k', make('b', 0)),
    queue.enqueue('k', make('c', 0)),
  ]);
  assert.deepEqual(order, [
    'start:a',
    'end:a',
    'start:b',
    'end:b',
    'start:c',
    'end:c',
  ]);
});

test('a rejected task does not break the queue chain', async () => {
  const clock = fakeClock();
  const queue = new AntiBanQueue({
    minIntervalMs: 0,
    maxJitterMs: 0,
    now: clock.now,
    sleep: clock.sleep,
  });
  await assert.rejects(
    queue.enqueue('k', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await queue.enqueue('k', async () => 'fine'), 'fine');
});
