/**
 * Local store modules for dashboard areas that the Fastify API does not
 * expose yet (Unified Inbox, SKU Catalog, Content Calendar — spec §7).
 *
 * Each store exposes the SAME async interface the future REST endpoints will
 * use (list/get/create/update), so swapping the localStorage backing for
 * `api` calls later is a one-file change. Data is persisted per-browser in
 * localStorage and seeded with realistic demo records on first run.
 */

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
// tiny localStorage-backed collection helper
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

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Inbox store — future endpoints: GET/POST /api/inbox/conversations,
// POST /api/inbox/conversations/:id/messages, PATCH .../:id (aiPaused)
// ---------------------------------------------------------------------------

const CONV_KEY = 'cb.inbox.conversations';
const MSG_KEY = 'cb.inbox.messages';

function seedConversations(): Conversation[] {
  return [
    {
      id: 'conv-1', channel: 'whatsapp', customerName: 'Ali Raza', customerHandle: '+92 300 1234567',
      language: 'ur', aiPaused: false, unread: 1, updatedAt: nowIso(),
    },
    {
      id: 'conv-2', channel: 'instagram', customerName: 'Sara Khan', customerHandle: '@sara.shops',
      language: 'en', aiPaused: true, unread: 0, updatedAt: nowIso(),
    },
    {
      id: 'conv-3', channel: 'whatsapp', customerName: 'Ahmed Ali', customerHandle: '+92 321 7654321',
      language: 'ur', aiPaused: false, unread: 0, updatedAt: nowIso(),
    },
  ];
}

function seedMessages(): Message[] {
  const t = Date.now();
  const at = (mins: number) => new Date(t - mins * 60000).toISOString();
  return [
    { id: 'm1', conversationId: 'conv-1', direction: 'in', author: 'customer', body: 'Assalam-o-Alaikum, is wall print ki price kya hai?', createdAt: at(32) },
    { id: 'm2', conversationId: 'conv-1', direction: 'out', author: 'ai', body: 'Walaikum Assalam! Yeh wall print PKR 1,500 ka hai. Kya aap order karna chahenge?', createdAt: at(31) },
    { id: 'm3', conversationId: 'conv-1', direction: 'in', author: 'customer', body: 'Delivery kitne din mein ho gi?', createdAt: at(5) },
    { id: 'm4', conversationId: 'conv-2', direction: 'in', author: 'customer', body: 'Hi! Do you deliver to Karachi?', createdAt: at(120) },
    { id: 'm5', conversationId: 'conv-2', direction: 'out', author: 'human', body: 'Hi Sara! Yes, we deliver to Karachi in 2–3 working days.', createdAt: at(118) },
    { id: 'm6', conversationId: 'conv-3', direction: 'in', author: 'customer', body: 'Mera order #1042 abhi tak nahi aaya.', createdAt: at(300) },
    { id: 'm7', conversationId: 'conv-3', direction: 'out', author: 'ai', body: 'Maazrat! Aap ka order courier ke paas hai, kal tak deliver ho jayega. Tracking: CB-88412.', createdAt: at(299) },
  ];
}

export const inboxStore = {
  async listConversations(): Promise<Conversation[]> {
    return load(CONV_KEY, seedConversations).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  async listMessages(conversationId: string): Promise<Message[]> {
    return load(MSG_KEY, seedMessages)
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  async sendMessage(conversationId: string, body: string): Promise<Message> {
    const messages = load(MSG_KEY, seedMessages);
    const message: Message = {
      id: nextId('msg'), conversationId, direction: 'out', author: 'human', body, createdAt: nowIso(),
    };
    messages.push(message);
    save(MSG_KEY, messages);
    const convs = load(CONV_KEY, seedConversations);
    save(CONV_KEY, convs.map((c) => (c.id === conversationId ? { ...c, updatedAt: nowIso(), unread: 0 } : c)));
    return message;
  },
  /** Human takeover toggle — pauses/resumes the AI assistant for a thread. */
  async setAiPaused(conversationId: string, aiPaused: boolean): Promise<Conversation> {
    const convs = load(CONV_KEY, seedConversations);
    const updated = convs.map((c) => (c.id === conversationId ? { ...c, aiPaused } : c));
    save(CONV_KEY, updated);
    const found = updated.find((c) => c.id === conversationId);
    if (!found) throw new Error('conversation_not_found');
    return found;
  },
};

// ---------------------------------------------------------------------------
// Catalog store — future endpoints: GET/POST/PUT /api/catalog/sku-mappings
// ---------------------------------------------------------------------------

const SKU_KEY = 'cb.catalog.skuMappings';

function seedSkus(): SkuMapping[] {
  return [
    { id: 'sku-1', masterSku: 'WP-FRAME-001', productName: 'Islamic Wall Print with Frame', shopifySku: 'WP-001-SH', darazSku: 'WP-001-DZ', localSku: 'WP-001-LC', stock: 42, price: 1500, currency: 'PKR', updatedAt: nowIso() },
    { id: 'sku-2', masterSku: 'LAMP-SUN-002', productName: 'Sunset Lamp 16 Colors', shopifySku: 'LMP-002-SH', darazSku: 'LMP-002-DZ', localSku: 'LMP-002-LC', stock: 17, price: 2200, currency: 'PKR', updatedAt: nowIso() },
    { id: 'sku-3', masterSku: 'MUG-MAG-003', productName: 'Magic Photo Mug', shopifySku: 'MUG-003-SH', darazSku: undefined, localSku: 'MUG-003-LC', stock: 0, price: 999, currency: 'PKR', updatedAt: nowIso() },
  ];
}

export const catalogStore = {
  async listMappings(): Promise<SkuMapping[]> {
    return load(SKU_KEY, seedSkus);
  },
  async upsertMapping(input: Omit<SkuMapping, 'id' | 'updatedAt'> & { id?: string }): Promise<SkuMapping> {
    const rows = load(SKU_KEY, seedSkus);
    if (input.id) {
      const next = rows.map((r) => (r.id === input.id ? { ...r, ...input, id: r.id, updatedAt: nowIso() } : r));
      save(SKU_KEY, next);
      return next.find((r) => r.id === input.id) as SkuMapping;
    }
    const row: SkuMapping = { ...input, id: nextId('sku'), updatedAt: nowIso() };
    rows.push(row);
    save(SKU_KEY, rows);
    return row;
  },
  async deleteMapping(id: string): Promise<void> {
    save(SKU_KEY, load(SKU_KEY, seedSkus).filter((r) => r.id !== id));
  },
};

// ---------------------------------------------------------------------------
// Calendar store — future endpoints: GET/POST/DELETE /api/calendar/items
// ---------------------------------------------------------------------------

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
