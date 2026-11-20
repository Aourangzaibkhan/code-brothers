/**
 * Store modules for the Unified Inbox, SKU Catalog and Content Calendar
 * (spec §7).
 *
 * Inbox and Catalog are backed by the real Fastify API (apps/api modules
 * `inbox.ts` / `catalog.ts`) through the typed client in `../api/client`.
 * The API shapes differ slightly from the dashboard's view models, so the
 * mapping lives here and the pages keep consuming the same interfaces:
 *
 *  - Conversation: the API exposes `externalId` + optional `displayName`
 *    (mapped to customerHandle / customerName). It has no per-conversation
 *    language or unread counter, so `language` is '' and `unread` is 0.
 *  - Message: the API calls the author field `sender`; mapped to `author`.
 *  - SkuMapping: the API stores stock and price PER CHANNEL
 *    (`stock: {shopify, daraz, local}`, `prices: {...}`) and has no product
 *    name or currency. The dashboard's single stock/price are written to
 *    every channel and read back from the first channel that has a value;
 *    `productName` is '' and `currency` defaults to 'PKR'.
 *
 * The Content Calendar has no API yet, so it stays localStorage-backed
 * (seeded with demo records on first run).
 */
import { api } from '../api/client';
import type {
  ApiConversation,
  ApiInboxMessage,
  ApiSkuMapping,
  CatalogChannel,
  SyncSaleResult,
} from '../api/types';

export interface Conversation {
  id: string;
  channel: 'whatsapp' | 'instagram';
  customerName: string;
  customerHandle: string;
  language: string;
  aiPaused: boolean;
  unread: number;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  author: 'customer' | 'ai' | 'human';
  body: string;
  createdAt: string;
}

export interface SkuMapping {
  id: string;
  masterSku: string;
  productName: string;
  shopifySku?: string;
  darazSku?: string;
  localSku?: string;
  stock: number;
  price: number;
  currency: string;
  updatedAt: string;
}

export interface CalendarItem {
  id: string;
  title: string;
  channel: 'youtube' | 'instagram' | 'facebook';
  /** ISO date (yyyy-mm-dd). */
  date: string;
  status: 'draft' | 'scheduled' | 'published';
  workflowId?: string;
}

// ---------------------------------------------------------------------------
// Inbox store — GET /api/inbox/conversations,
// GET /api/inbox/conversations/:id/messages,
// POST /api/inbox/conversations/:id/reply,
// POST /api/inbox/conversations/:id/takeover
// ---------------------------------------------------------------------------

function toConversation(c: ApiConversation): Conversation {
  return {
    id: c.id,
    channel: c.channel,
    customerName: c.displayName ?? c.externalId,
    customerHandle: c.externalId,
    language: '',
    aiPaused: c.aiPaused,
    unread: 0,
    updatedAt: c.updatedAt,
  };
}

function toMessage(m: ApiInboxMessage): Message {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    author: m.sender,
    body: m.body,
    createdAt: m.createdAt,
  };
}

export const inboxStore = {
  async listConversations(): Promise<Conversation[]> {
    const conversations = await api.listInboxConversations();
    return conversations.map(toConversation);
  },
  async listMessages(conversationId: string): Promise<Message[]> {
    const { messages } = await api.listInboxMessages(conversationId);
    return messages.map(toMessage);
  },
  /** Human reply — the API records it and auto-pauses the AI (§7.1). */
  async sendMessage(conversationId: string, body: string): Promise<Message> {
    const { message } = await api.replyToConversation(conversationId, body);
    return toMessage(message);
  },
  /** Human takeover toggle — pauses/resumes the AI assistant for a thread. */
  async setAiPaused(conversationId: string, aiPaused: boolean): Promise<Conversation> {
    const conversation = await api.setConversationTakeover(conversationId, aiPaused);
    return toConversation(conversation);
  },
};

// ---------------------------------------------------------------------------
// Catalog store — GET/POST/PUT/DELETE /api/catalog/sku-mappings,
// POST /api/catalog/sync-sale
// ---------------------------------------------------------------------------

function toSkuMapping(m: ApiSkuMapping): SkuMapping {
  return {
    id: m.id,
    masterSku: m.masterSku,
    productName: '',
    shopifySku: m.shopifySku,
    darazSku: m.darazSku,
    localSku: m.localSku,
    stock: m.stock.shopify ?? m.stock.daraz ?? m.stock.local ?? 0,
    price: m.prices.shopify ?? m.prices.daraz ?? m.prices.local ?? 0,
    currency: 'PKR',
    updatedAt: m.updatedAt,
  };
}

export const catalogStore = {
  async listMappings(): Promise<SkuMapping[]> {
    const mappings = await api.listSkuMappings();
    return mappings.map(toSkuMapping);
  },
  async upsertMapping(input: Omit<SkuMapping, 'id' | 'updatedAt'> & { id?: string }): Promise<SkuMapping> {
    // The dashboard edits one stock/price for the whole product; the API
    // tracks them per channel, so the same value is written to all three.
    const payload = {
      masterSku: input.masterSku,
      shopifySku: input.shopifySku,
      darazSku: input.darazSku,
      localSku: input.localSku,
      stock: { shopify: input.stock, daraz: input.stock, local: input.stock },
      prices: { shopify: input.price, daraz: input.price, local: input.price },
    };
    const saved = input.id
      ? await api.updateSkuMapping(input.id, payload)
      : await api.createSkuMapping(payload);
    return toSkuMapping(saved);
  },
  async deleteMapping(id: string): Promise<void> {
    await api.deleteSkuMapping(id);
  },
  /** Record a sale on one channel; the API deducts it from every channel. */
  async syncSale(channel: CatalogChannel, channelSku: string, qty: number): Promise<SyncSaleResult> {
    return api.syncCatalogSale({ channel, channelSku, qty });
  },
};

// ---------------------------------------------------------------------------
// Calendar store — no API exists yet; localStorage-backed.
// ---------------------------------------------------------------------------

function load<T>(key: string, seed: () => T[]): T[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T[];
  } catch {
    /* fall through to seed */
  }
  const data = seed();
  save(key, data);
  return data;
}

function save<T>(key: string, data: T[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* storage full/unavailable — keep in-memory state only */
  }
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

const CAL_KEY = 'cb.calendar.items';

function seedCalendar(): CalendarItem[] {
  const today = new Date();
  const d = (offset: number) => {
    const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    return dt.toISOString().slice(0, 10);
  };
  return [
    { id: 'cal-1', title: 'New wall print launch — Reel', channel: 'instagram', date: d(1), status: 'scheduled' },
    { id: 'cal-2', title: 'Daraz sale announcement Short', channel: 'youtube', date: d(3), status: 'draft' },
    { id: 'cal-3', title: 'Customer review carousel', channel: 'instagram', date: d(-2), status: 'published' },
  ];
}

export const calendarStore = {
  async listItems(): Promise<CalendarItem[]> {
    return load(CAL_KEY, seedCalendar);
  },
  async createItem(input: Omit<CalendarItem, 'id'>): Promise<CalendarItem> {
    const items = load(CAL_KEY, seedCalendar);
    const item: CalendarItem = { ...input, id: nextId('cal') };
    items.push(item);
    save(CAL_KEY, items);
    return item;
  },
  async deleteItem(id: string): Promise<void> {
    save(CAL_KEY, load(CAL_KEY, seedCalendar).filter((i) => i.id !== id));
  },
};
