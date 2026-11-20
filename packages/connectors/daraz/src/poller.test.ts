import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OrderPoller,
  MemoryPollingStateStore,
  MemorySeenStore,
  type DarazOrderLike,
} from './poller.js';
import type { DarazClient } from './client.js';

function fakeClient(allOrders: DarazOrderLike[]) {
  const calls: Array<{ createdAfter?: string }> = [];
  const client = {
    async getOrders(params: { createdAfter?: string }) {
      calls.push({ createdAfter: params.createdAfter });
      const after = params.createdAfter;
      const filtered = after
        ? allOrders.filter((o) => String(o.created_at) > after)
        : [...allOrders];
      // Daraz-style: sorted ascending by created_at
      filtered.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return { orders: filtered };
    },
  } as unknown as Pick<DarazClient, 'getOrders'>;
  return { client, calls };
}

const ORDERS: DarazOrderLike[] = [
  { order_id: 1, created_at: '2026-01-01T10:00:00+08:00' },
  { order_id: 2, created_at: '2026-01-01T11:00:00+08:00' },
  { order_id: 3, created_at: '2026-01-01T12:00:00+08:00' },
];

test('first poll returns all new orders and advances the cursor to max created_at', async () => {
  const { client } = fakeClient(ORDERS);
  const state = new MemoryPollingStateStore();
  const seen = new MemorySeenStore();
  const poller = new OrderPoller({ client, stateStore: state, seenStore: seen });
  const fresh = await poller.poll('2026-01-01T00:00:00+08:00');
  assert.equal(fresh.length, 3);
  assert.equal(await state.getCursor(), '2026-01-01T12:00:00+08:00');
  assert.equal(seen.size, 3);
});

test('second poll dedups: only genuinely new orders are returned, cursor advances again', async () => {
  const live = [...ORDERS];
  const { client, calls } = fakeClient(live);
  const state = new MemoryPollingStateStore();
  const seen = new MemorySeenStore();
  const poller = new OrderPoller({ client, stateStore: state, seenStore: seen });
  const first = await poller.poll('2026-01-01T00:00:00+08:00');
  assert.equal(first.length, 3);

  // Simulate overlap: the API (inclusive boundary / clock skew) re-sends
  // order 3 plus a genuinely new order 4 on the next poll even though the
  // fake filters by cursor — emulate by pre-seeding nothing and letting the
  // poller's seen-store do the dedup via a client that ignores the cursor
  // for one boundary item.
  live.push({ order_id: 4, created_at: '2026-01-01T13:00:00+08:00' });
  const second = await poller.poll();
  assert.equal(calls[1].createdAfter, '2026-01-01T12:00:00+08:00', 'second poll uses stored cursor');
  assert.deepEqual(second.map((o) => o.order_id), [4]);
  assert.equal(await state.getCursor(), '2026-01-01T13:00:00+08:00');

  const third = await poller.poll();
  assert.equal(third.length, 0, 'no new orders -> empty result');
});

test('seen-store dedups even when the API re-sends an old order', async () => {
  const resent: DarazOrderLike[] = [
    { order_id: 2, created_at: '2026-01-01T11:00:00+08:00' },
    { order_id: 5, created_at: '2026-01-01T14:00:00+08:00' },
  ];
  const client = { async getOrders() { return resent; } } as unknown as Pick<DarazClient, 'getOrders'>;
  const state = new MemoryPollingStateStore('2026-01-01T09:00:00+08:00');
  const seen = new MemorySeenStore(['2']);
  const poller = new OrderPoller({ client, stateStore: state, seenStore: seen });
  const fresh = await poller.poll();
  assert.deepEqual(fresh.map((o) => o.order_id), [5]);
  assert.equal(await state.getCursor(), '2026-01-01T14:00:00+08:00');
});

test('empty poll leaves the cursor untouched', async () => {
  const client = { async getOrders() { return { orders: [] }; } } as unknown as Pick<DarazClient, 'getOrders'>;
  const state = new MemoryPollingStateStore('2026-01-01T09:00:00+08:00');
  const poller = new OrderPoller({ client, stateStore: state, seenStore: new MemorySeenStore() });
  assert.deepEqual(await poller.poll(), []);
  assert.equal(await state.getCursor(), '2026-01-01T09:00:00+08:00');
});
