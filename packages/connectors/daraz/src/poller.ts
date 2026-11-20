import type { DarazClient } from './client.js';

/**
 * Incremental order polling for Daraz: fetch orders created after a stored
 * cursor, deduplicate against a seen-store, advance the cursor to the
 * newest `created_at` fetched, and return only genuinely new orders.
 */

export interface PollingStateStore {
  getCursor(): Promise<string | undefined>;
  setCursor(cursor: string): Promise<void>;
}

export interface SeenStore {
  has(id: string): Promise<boolean>;
  add(id: string): Promise<void>;
}

export class MemoryPollingStateStore implements PollingStateStore {
  private cursor: string | undefined;
  constructor(initialCursor?: string) {
    this.cursor = initialCursor;
  }
  async getCursor(): Promise<string | undefined> {
    return this.cursor;
  }
  async setCursor(cursor: string): Promise<void> {
    this.cursor = cursor;
  }
}

export class MemorySeenStore implements SeenStore {
  private readonly ids = new Set<string>();
  constructor(initialIds: Iterable<string> = []) {
    for (const id of initialIds) this.ids.add(String(id));
  }
  async has(id: string): Promise<boolean> {
    return this.ids.has(String(id));
  }
  async add(id: string): Promise<void> {
    this.ids.add(String(id));
  }
  get size(): number {
    return this.ids.size;
  }
}

export type DarazOrderLike = Record<string, unknown> & {
  order_id?: string | number;
  id?: string | number;
  created_at?: string;
};

function extractOrders(result: unknown): DarazOrderLike[] {
  if (Array.isArray(result)) return result as DarazOrderLike[];
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.orders)) return obj.orders as DarazOrderLike[];
    if (Array.isArray(obj.order_list)) return obj.order_list as DarazOrderLike[];
  }
  return [];
}

function orderIdOf(order: DarazOrderLike): string {
  return String(order.order_id ?? order.id ?? '');
}

export interface OrderPollerOptions {
  client: Pick<DarazClient, 'getOrders'>;
  stateStore: PollingStateStore;
  seenStore: SeenStore;
  pageSize?: number;
}

export class OrderPoller {
  private readonly client: OrderPollerOptions['client'];
  private readonly stateStore: PollingStateStore;
  private readonly seenStore: SeenStore;
  private readonly pageSize: number;

  constructor(options: OrderPollerOptions) {
    this.client = options.client;
    this.stateStore = options.stateStore;
    this.seenStore = options.seenStore;
    this.pageSize = options.pageSize ?? 100;
  }

  async poll(createdAfterFallback?: string): Promise<DarazOrderLike[]> {
    const cursor = (await this.stateStore.getCursor()) ?? createdAfterFallback;
    const fresh: DarazOrderLike[] = [];
    let maxCreatedAt: string | undefined;
    let offset = 0;
    for (;;) {
      const result = await this.client.getOrders({
        createdAfter: cursor,
        limit: this.pageSize,
        offset,
      });
      const batch = extractOrders(result);
      if (batch.length === 0) break;
      for (const order of batch) {
        const createdAt = order.created_at ? String(order.created_at) : undefined;
        if (createdAt && (maxCreatedAt === undefined || createdAt > maxCreatedAt)) {
          maxCreatedAt = createdAt;
        }
        const id = orderIdOf(order);
        if (!id) continue;
        if (await this.seenStore.has(id)) continue;
        await this.seenStore.add(id);
        fresh.push(order);
      }
      if (batch.length < this.pageSize) break;
      offset += batch.length;
    }
    if (maxCreatedAt && maxCreatedAt !== cursor) {
      await this.stateStore.setCursor(maxCreatedAt);
    }
    return fresh;
  }
}
