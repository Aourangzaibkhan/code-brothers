/**
 * Instagram / Meta webhook helpers: X-Hub-Signature-256 verification and
 * normalisation of comment events.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface InstagramCommentEvent {
  entryId: string;
  mediaId: string;
  commentId: string;
  fromId: string;
  fromUsername?: string;
  text: string;
  timestamp: number;
}

/**
 * Verify a Meta webhook signature header (`sha256=<hex>`) against the raw
 * request body using HMAC-SHA256 keyed with the app secret. The comparison
 * is constant-time; malformed headers simply return false.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;
  const providedHex = signatureHeader.slice('sha256='.length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(providedHex)) return false;
  const expectedHex = createHmac('sha256', appSecret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
  const expected = Buffer.from(expectedHex, 'utf8');
  const provided = Buffer.from(providedHex, 'utf8');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/**
 * Extract normalised comment events from a webhook payload:
 * entry[].changes[] where field === 'comments'. Both the Instagram shape
 * (value.media.id / value.from) is supported.
 */
export function parseCommentEvents(payload: unknown): InstagramCommentEvent[] {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.entry)) return [];
  const events: InstagramCommentEvent[] = [];
  for (const rawEntry of root.entry) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    const entryId = asString(entry.id);
    const entryTime = typeof entry.time === 'number' ? entry.time : undefined;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const rawChange of changes) {
      const change = asRecord(rawChange);
      if (!change || change.field !== 'comments') continue;
      const value = asRecord(change.value) ?? {};
      const from = asRecord(value.from) ?? {};
      const media = asRecord(value.media) ?? {};
      const timestamp =
        entryTime ??
        (typeof value.created_time === 'number'
          ? value.created_time
          : typeof value.timestamp === 'number'
            ? value.timestamp
            : 0);
      events.push({
        entryId,
        mediaId: asString(media.id ?? value.media_id),
        commentId: asString(value.id ?? value.comment_id),
        fromId: asString(from.id ?? value.from_id),
        fromUsername:
          typeof from.username === 'string'
            ? from.username
            : typeof value.username === 'string'
              ? value.username
              : undefined,
        text: asString(value.text ?? value.message),
        timestamp,
      });
    }
  }
  return events;
}
