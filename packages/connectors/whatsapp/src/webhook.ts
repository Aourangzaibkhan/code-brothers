import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  NormalizedIncomingMessage,
  NormalizedMessageStatus,
  NormalizedWhatsAppEvent,
} from './types.js';

/**
 * Helpers for the Meta WhatsApp Cloud API webhook endpoint.
 *
 * Verification flow (real Meta behaviour):
 *  - GET: Meta sends hub.mode=subscribe, hub.verify_token and hub.challenge;
 *    the endpoint must echo the challenge when the token matches.
 *  - POST: every delivery is signed with the app secret in the
 *    `X-Hub-Signature-256: sha256=<hex hmac-sha256 of raw body>` header.
 */

/** Return the challenge to echo, or null when verification fails. */
export function verifyWebhookChallenge(
  query: Record<string, string | undefined>,
  verifyToken: string,
): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === verifyToken && challenge) {
    return challenge;
  }
  return null;
}

/** Verify an X-Hub-Signature-256 header against the raw request body. */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader) return false;
  const expectedHex = createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');
  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  const expectedBuf = Buffer.from(expectedHex, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

interface RawChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: Array<Record<string, unknown>>;
  statuses?: Array<Record<string, unknown>>;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizeMessage(
  raw: Record<string, unknown>,
  value: RawChangeValue,
): NormalizedIncomingMessage {
  const type = stringField(raw, 'type') ?? 'unknown';
  const senderName = value.contacts?.[0]?.profile?.name;
  const event: NormalizedIncomingMessage = {
    kind: 'message',
    messageId: stringField(raw, 'id') ?? '',
    from: stringField(raw, 'from') ?? '',
    senderName,
    timestamp: Number(raw['timestamp'] ?? 0),
    type,
    phoneNumberId: value.metadata?.phone_number_id,
  };
  if (type === 'text') {
    const text = raw['text'] as { body?: string } | undefined;
    event.text = text?.body;
  }
  const mediaTypes = ['image', 'video', 'document', 'audio', 'sticker', 'voice'];
  if (mediaTypes.includes(type)) {
    const media = raw[type] as { id?: string; caption?: string } | undefined;
    event.mediaId = media?.id;
    event.caption = media?.caption;
  }
  if (type === 'location') {
    const loc = raw['location'] as
      | { latitude?: number; longitude?: number; name?: string; address?: string }
      | undefined;
    if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
      event.location = {
        latitude: loc.latitude,
        longitude: loc.longitude,
        name: loc.name,
        address: loc.address,
      };
    }
  }
  if (type === 'reaction') {
    const reaction = raw['reaction'] as { emoji?: string } | undefined;
    event.text = reaction?.emoji;
  }
  return event;
}

function normalizeStatus(
  raw: Record<string, unknown>,
  value: RawChangeValue,
): NormalizedMessageStatus {
  return {
    kind: 'status',
    messageId: stringField(raw, 'id') ?? '',
    recipientId: stringField(raw, 'recipient_id') ?? '',
    status: stringField(raw, 'status') ?? '',
    timestamp: Number(raw['timestamp'] ?? 0),
    phoneNumberId: value.metadata?.phone_number_id,
  };
}

/**
 * Parse a raw Cloud API webhook payload into normalized events (incoming
 * messages + status updates). Unknown shapes yield an empty array rather
 * than throwing — webhook endpoints must ack Meta even for odd payloads.
 */
export function parseWebhookEvents(payload: unknown): NormalizedWhatsAppEvent[] {
  const events: NormalizedWhatsAppEvent[] = [];
  if (!payload || typeof payload !== 'object') return events;
  const root = payload as {
    entry?: Array<{ changes?: Array<{ field?: string; value?: RawChangeValue }> }>;
  };
  if (!Array.isArray(root.entry)) return events;
  for (const entry of root.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages' || !change.value) continue;
      const value = change.value;
      for (const message of value.messages ?? []) {
        events.push(normalizeMessage(message, value));
      }
      for (const status of value.statuses ?? []) {
        events.push(normalizeStatus(status, value));
      }
    }
  }
  return events;
}
