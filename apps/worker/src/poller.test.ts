import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryPollingStateStore, Poller } from './poller.js';

describe('Poller', () => {
  it('threads the cursor through the injected state store and emits items', async () => {
    const store = new InMemoryPollingStateStore();
    const received: unknown[][] = [];
    const seenCursors: Array<string | undefined> = [];
    let calls = 0;

    const poller = new Poller({
      key: 'daraz-orders',
      stateStore: store,
      poll: async (cursor) => {
        calls++;
        seenCursors.push(cursor);
        return calls === 1
          ? { cursor: 'cursor-1', items: [{ id: 1 }] }
          : { cursor: 'cursor-2', items: [] };
      },
      onItems: (items) => {
        received.push(items);
      },
    });

    assert.equal(await poller.cursor(), undefined);

    const first = await poller.tick();
    assert.equal(first.cursor, 'cursor-1');
    assert.equal(await store.get('daraz-orders'), 'cursor-1');

    const second = await poller.tick();
    assert.equal(second.cursor, 'cursor-2');
    assert.equal(await store.get('daraz-orders'), 'cursor-2');

    // The second cycle received the cursor persisted by the first.
    assert.deepEqual(seenCursors, [undefined, 'cursor-1']);
    // Items were emitted exactly once (the empty second cycle emits nothing).
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], [{ id: 1 }]);
  });
});
