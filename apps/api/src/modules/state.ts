/**
 * In-memory state for the business/operations modules (spec §7).
 *
 * Following the pattern of ../store.ts, every collection lives behind a
 * plain data holder here; route modules in this folder implement the
 * repository-style operations against it. {@link OpsState.snapshot} /
 * {@link OpsState.restore} power the encrypted backup endpoints (§7.6):
 * a snapshot is a JSON-safe deep copy of every ops collection.
 */
import { randomUUID } from 'node:crypto';

export type Channel = 'shopify' | 'daraz' | 'local';
export const CHANNELS: Channel[] = ['shopify', 'daraz', 'local'];

/** sku_mappings row (spec §9) + channel pricing rules (§7.2) + stock ledger. */
export interface SkuMappingRecord {
  id: string;
  userId: string;
  masterSku: string;
  shopifySku?: string;
  shopifyProductId?: string;
  darazSku?: string;
  darazItemId?: string;
  localSku?: string;
  localProductId?: string;
  /** Channel-specific price overrides (§7.2 pricing rules). */
  prices: Partial<Record<Channel, number>>;
  /** In-memory stock ledger: units currently listed per channel. */
  stock: Record<Channel, number>;
  createdAt: string;
  updatedAt: string;
}

/** customers_crm row (spec §9) — Customer 360 + COD risk bookkeeping. */
export interface CustomerRecord {
  id: string;
  userId: string;
  name?: string;
  /** Normalized phone (+<country><number>) — unique per merchant (§9). */
  phone?: string;
  email?: string;
  preferredLanguage: string;
  /** Last computed COD risk score, 0 (trusted) – 100 (block). */
  codRiskScore: number;
  totalOrders: number;
  codOrdersCount: number;
  /** Refused/returned COD parcels — the repeat-canceller signal. */
  codRefusalsCount: number;
  totalSpent: number;
  channelRefs: Record<string, string>;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type OrderStatus = 'completed' | 'delivered' | 'cancelled' | 'returned' | 'pending';

export interface OrderItemRecord {
  sku?: string;
  name: string;
  qty: number;
  unitPrice: number;
}

export interface OrderRecord {
  id: string;
  userId: string;
  customerId?: string;
  /** Normalized buyer phone, when known (fraud + digest joins). */
  phone?: string;
  channel: string;
  items: OrderItemRecord[];
  total: number;
  currency: string;
  status: OrderStatus;
  paymentMethod: 'cod' | 'prepaid';
  createdAt: string;
}

export type TidProvider = 'jazzcash' | 'easypaisa' | 'bank' | 'upi' | 'pix' | 'other';

/** payment_tids row (spec §9) — `tid` is globally unique: the duplicate shield. */
export interface PaymentTidRecord {
  id: string;
  userId: string;
  tid: string;
  provider: TidProvider;
  amount: number;
  currency: string;
  orderRef?: string;
  customerId?: string;
  status: 'verified' | 'rejected';
  /** How many later attempts tried to re-verify this same TID. */
  duplicateAttempts: number;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type InboxChannel = 'whatsapp' | 'instagram';

export interface ConversationRecord {
  id: string;
  userId: string;
  channel: InboxChannel;
  /** Buyer identity on the channel (phone number / IG user id). */
  externalId: string;
  displayName?: string;
  customerId?: string;
  /** Human takeover state (§7.1): while true the AI never auto-replies. */
  aiPaused: boolean;
  pausedUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InboxMessageRecord {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  sender: 'customer' | 'ai' | 'human';
  body: string;
  createdAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';

export interface ApprovalRecord {
  id: string;
  userId: string;
  /** e.g. 'refund', 'discount', 'send_message', 'video_post'. */
  type: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  requestedBy?: string;
  decidedBy?: string;
  decisionNote?: string;
  executionResult?: unknown;
  executionError?: string;
  createdAt: string;
  decidedAt?: string;
}

/** A message actually sent by an approved action (demo executor output). */
export interface SentMessageRecord {
  id: string;
  userId: string;
  channel?: string;
  to?: string;
  body?: string;
  approvalId: string;
  sentAt: string;
}

/** Runs an approved action. Registered per approval `type`. */
export type ApprovalExecutor = (
  payload: Record<string, unknown>,
  ctx: { ops: OpsState; userId: string; approvalId: string },
) => Promise<unknown> | unknown;

/** Produces an automatic reply for an inbound inbox message (or none). */
export type AutoResponder = (ctx: {
  conversation: ConversationRecord;
  message: InboxMessageRecord;
}) => Promise<string | undefined> | string | undefined;

export interface OpsSnapshot {
  version: 1;
  skuMappings: SkuMappingRecord[];
  customers: CustomerRecord[];
  orders: OrderRecord[];
  paymentTids: PaymentTidRecord[];
  conversations: ConversationRecord[];
  messages: InboxMessageRecord[];
  approvals: ApprovalRecord[];
  sentMessages: SentMessageRecord[];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class OpsState {
  readonly skuMappings = new Map<string, SkuMappingRecord>();
  readonly customers = new Map<string, CustomerRecord>();
  readonly orders = new Map<string, OrderRecord>();
  readonly paymentTids = new Map<string, PaymentTidRecord>();
  readonly conversations = new Map<string, ConversationRecord>();
  readonly messages = new Map<string, InboxMessageRecord>();
  readonly approvals = new Map<string, ApprovalRecord>();
  readonly sentMessages: SentMessageRecord[] = [];
  /** Approval executors by action type (functions — never snapshotted). */
  readonly executors = new Map<string, ApprovalExecutor>();
  /** Pluggable inbox auto-responder (rule-based default set at registration). */
  autoResponder?: AutoResponder;

  newId(): string {
    return randomUUID();
  }

  registerExecutor(type: string, executor: ApprovalExecutor): void {
    this.executors.set(type, executor);
  }

  snapshot(): OpsSnapshot {
    return clone({
      version: 1,
      skuMappings: [...this.skuMappings.values()],
      customers: [...this.customers.values()],
      orders: [...this.orders.values()],
      paymentTids: [...this.paymentTids.values()],
      conversations: [...this.conversations.values()],
      messages: [...this.messages.values()],
      approvals: [...this.approvals.values()],
      sentMessages: this.sentMessages,
    });
  }

  restore(snapshot: OpsSnapshot): void {
    const data = clone(snapshot);
    this.clearAll();
    for (const row of data.skuMappings ?? []) this.skuMappings.set(row.id, row);
    for (const row of data.customers ?? []) this.customers.set(row.id, row);
    for (const row of data.orders ?? []) this.orders.set(row.id, row);
    for (const row of data.paymentTids ?? []) this.paymentTids.set(row.id, row);
    for (const row of data.conversations ?? []) this.conversations.set(row.id, row);
    for (const row of data.messages ?? []) this.messages.set(row.id, row);
    for (const row of data.approvals ?? []) this.approvals.set(row.id, row);
    this.sentMessages.push(...(data.sentMessages ?? []));
  }

  clearAll(): void {
    this.skuMappings.clear();
    this.customers.clear();
    this.orders.clear();
    this.paymentTids.clear();
    this.conversations.clear();
    this.messages.clear();
    this.approvals.clear();
    this.sentMessages.length = 0;
  }

  counts(): Record<string, number> {
    return {
      skuMappings: this.skuMappings.size,
      customers: this.customers.size,
      orders: this.orders.size,
      paymentTids: this.paymentTids.size,
      conversations: this.conversations.size,
      messages: this.messages.size,
      approvals: this.approvals.size,
      sentMessages: this.sentMessages.length,
    };
  }
}

export function createOpsState(): OpsState {
  return new OpsState();
}
