import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginThrottle, MemoryThrottleStore } from './throttle.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

test('not locked below the failure threshold', () => {
  const clock = fakeClock();
  const throttle = new LoginThrottle({ now: clock.now });
  for (let i = 0; i < 4; i += 1) {
    const status = throttle.recordFailure('user@example.com');
    assert.equal(status.locked, false);
    assert.equal(status.remainingAttempts, 4 - i);
  }
  assert.equal(throttle.isLocked('user@example.com'), false);
});

test('locks after 5 failures within the window (spec default)', () => {
  const clock = fakeClock();
  const throttle = new LoginThrottle({ now: clock.now });
  let status;
  for (let i = 0; i < 5; i += 1) status = throttle.recordFailure('victim');
  assert.equal(status?.locked, true);
  assert.equal(throttle.isLocked('victim'), true);
  assert.equal(status?.remainingAttempts, 0);
  assert.ok((status?.retryAfterMs ?? 0) > 14 * 60 * 1000);
  assert.ok((status?.retryAfterMs ?? 0) <= 15 * 60 * 1000);
});

test('lock expires after 15 minutes', () => {
  const clock = fakeClock();
  const throttle = new LoginThrottle({ now: clock.now });
  for (let i = 0; i < 5; i += 1) throttle.recordFailure('victim');
  assert.equal(throttle.isLocked('victim'), true);
  clock.advance(14 * 60 * 1000);
  assert.equal(throttle.isLocked('victim'), true);
  clock.advance(60 * 1000 + 1);
  assert.equal(throttle.isLocked('victim'), false);
  // After expiry the counter restarts clean.
  assert.equal(throttle.getStatus('victim').failureCount, 0);
});

test('failures outside the 10-minute window do not accumulate', () => {
  const clock = fakeClock();
  const throttle = new LoginThrottle({ now: clock.now });
  for (let i = 0; i < 4; i += 1) throttle.recordFailure('slow-attacker');
  clock.advance(10 * 60 * 1000 + 1);
  const status = throttle.recordFailure('slow-attacker');
  assert.equal(status.locked, false);
  assert.equal(status.failureCount, 1);
});

test('recordSuccess clears failures and prevents lockout', () => {
  const clock = fakeClock();
  const throttle = new LoginThrottle({ now: clock.now });
  for (let i = 0; i < 4; i += 1) throttle.recordFailure('user');
  throttle.recordSuccess('user');
  assert.equal(throttle.getStatus('user').failureCount, 0);
  for (let i = 0; i < 4; i += 1) throttle.recordFailure('user');
  assert.equal(throttle.isLocked('user'), false);
});

test('keys are tracked independently', () => {
  const clock = fakeClock();
  const throttle = new LoginThrottle({ now: clock.now });
  for (let i = 0; i < 5; i += 1) throttle.recordFailure('ip:1.2.3.4');
  assert.equal(throttle.isLocked('ip:1.2.3.4'), true);
  assert.equal(throttle.isLocked('ip:5.6.7.8'), false);
  assert.equal(throttle.isLocked('user@example.com'), false);
});

test('failures during an active lock do not extend it', () => {
  const clock = fakeClock();
  const throttle = new LoginThrottle({ now: clock.now });
  for (let i = 0; i < 5; i += 1) throttle.recordFailure('victim');
  const until = throttle.getStatus('victim').lockedUntil;
  clock.advance(5 * 60 * 1000);
  throttle.recordFailure('victim');
  assert.equal(throttle.getStatus('victim').lockedUntil, until);
});

test('custom thresholds are honored', () => {
  const clock = fakeClock();
  const throttle = new LoginThrottle({ maxFailures: 3, windowMs: 60_000, lockMs: 30_000, now: clock.now });
  throttle.recordFailure('k');
  throttle.recordFailure('k');
  assert.equal(throttle.isLocked('k'), false);
  throttle.recordFailure('k');
  assert.equal(throttle.isLocked('k'), true);
  clock.advance(30_001);
  assert.equal(throttle.isLocked('k'), false);
});

test('works with a custom store implementation', () => {
  const backing = new Map<string, { failures: number[]; lockedUntil?: number }>();
  const store = {
    get: (k: string) => backing.get(k),
    set: (k: string, e: { failures: number[]; lockedUntil?: number }) => { backing.set(k, e); },
    delete: (k: string) => { backing.delete(k); },
  };
  const throttle = new LoginThrottle({ store });
  for (let i = 0; i < 5; i += 1) throttle.recordFailure('k');
  assert.equal(throttle.isLocked('k'), true);
  assert.ok(backing.size >= 1);
  throttle.recordSuccess('k');
  assert.equal(backing.size, 0);
});

test('MemoryThrottleStore is the default and tracks state', () => {
  const store = new MemoryThrottleStore();
  const throttle = new LoginThrottle({ store });
  throttle.recordFailure('a');
  assert.equal(store.size, 1);
  throttle.recordSuccess('a');
  assert.equal(store.size, 0);
});

test('invalid options are rejected', () => {
  assert.throws(() => new LoginThrottle({ maxFailures: 0 }), RangeError);
  assert.throws(() => new LoginThrottle({ lockMs: 0 }), RangeError);
});
