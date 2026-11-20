import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Universal signed-webhook kit.
 *
 * Every outbound webhook is signed with HMAC-SHA256 over the exact raw body
 * bytes, so receivers can verify authenticity (and integrity) before parsing.
 * The signature travels in `X-CodeBrothers-Signature` as `sha256=<hex>`.
 */

export const WEBHOOK_EVENT_HEADER = 'X-CodeBrothers-Event';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-CodeBrothers-Timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'X-CodeBrothers-Signature';
export const WEBHOOK_SOURCE_HEADER = 'X-CodeBrothers-Source';

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

function toBuffer(rawBody: string | Buffer): Buffer {
  return Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
}

/** Hex HMAC-SHA256 of the raw body under `secret`. */
export function signWebhookPayload(
  rawBody: string | Buffer,
  secret: string,
): string {
  return createHmac('sha256', secret).update(toBuffer(rawBody)).digest('hex');
}

/**
 * Build the signed headers for an outbound webhook. `timestamp` is a
 * millisecond epoch value (string or number); defaults to now.
 */
export function buildWebhookHeaders(
  event: string,
  rawBody: string | Buffer,
  secret: string,
  timestamp?: string | number,
): Record<string, string> {
  const ts =
    timestamp === undefined ? String(Date.now()) : String(timestamp);
  return {
    [WEBHOOK_EVENT_HEADER]: event,
    [WEBHOOK_TIMESTAMP_HEADER]: ts,
    [WEBHOOK_SIGNATURE_HEADER]: `sha256=${signWebhookPayload(rawBody, secret)}`,
  };
}

/**
 * Constant-time verification of a signature header against the raw body.
 * Accepts both `sha256=<hex>` and a bare hex digest. Never throws — any
 * malformed input is simply `false`.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secret: string,
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  if (!/^[0-9a-fA-F]+$/.test(provided)) return false;
  const expectedHex = signWebhookPayload(rawBody, secret);
  const expectedBuf = Buffer.from(expectedHex, 'utf8');
  const providedBuf = Buffer.from(provided.toLowerCase(), 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export interface WebhookEmitterOptions {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  /** Optional source label, sent as `X-CodeBrothers-Source`. */
  source?: string;
}

export interface WebhookEmitResult {
  status: number;
  body: string;
}

/** Sends signed webhook events to one endpoint. */
export class WebhookEmitter {
  private readonly url: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly source?: string;

  constructor(options: WebhookEmitterOptions) {
    this.url = options.url;
    this.secret = options.secret;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.source = options.source;
  }

  /**
   * POST `{ event, data, sentAt }` as JSON with the signed headers.
   * Throws on any non-2xx response; resolves with `{ status, body }`.
   */
  async emit(event: string, data: unknown): Promise<WebhookEmitResult> {
    const rawBody = JSON.stringify({
      event,
      data,
      sentAt: new Date().toISOString(),
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...buildWebhookHeaders(event, rawBody, this.secret),
    };
    if (this.source) headers[WEBHOOK_SOURCE_HEADER] = this.source;
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: rawBody,
    });
    const body = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Webhook delivery to ${this.url} failed with HTTP ${response.status}: ${body}`,
      );
    }
    return { status: response.status, body };
  }
}

export type WebhookHeaders = Record<
  string,
  string | string[] | undefined
>;

function headerValue(
  headers: WebhookHeaders,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

export interface VerifiedWebhook<T = unknown> {
  event: string;
  data: T;
}

export type WebhookHandler<T = unknown, R = unknown> = (
  data: T,
  event: string,
) => R | Promise<R>;

/** Verifies and dispatches inbound signed webhooks. */
export class WebhookReceiver {
  private readonly secret: string;

  constructor(options: { secret: string }) {
    this.secret = options.secret;
  }

  /**
   * Verify the signature header against the raw body, then parse the
   * `{ event, data }` envelope. Throws {@link WebhookVerificationError} on a
   * bad signature, a missing event header, or a malformed body.
   */
  verifyAndParse<T = unknown>(
    rawBody: string | Buffer,
    headers: WebhookHeaders,
  ): VerifiedWebhook<T> {
    const signature = headerValue(headers, WEBHOOK_SIGNATURE_HEADER);
    if (!verifyWebhookSignature(rawBody, signature, this.secret)) {
      throw new WebhookVerificationError(
        'Webhook signature verification failed',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(toBuffer(rawBody).toString('utf8')) as unknown;
    } catch {
      throw new WebhookVerificationError('Webhook body is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new WebhookVerificationError('Webhook body must be a JSON object');
    }
    const envelope = parsed as { event?: unknown; data?: unknown };
    const event =
      typeof envelope.event === 'string'
        ? envelope.event
        : headerValue(headers, WEBHOOK_EVENT_HEADER);
    if (!event) {
      throw new WebhookVerificationError('Webhook event type is missing');
    }
    return { event, data: envelope.data as T };
  }

  /**
   * Verify, parse and dispatch to the handler registered for the event type
   * (e.g. `order.created`, `lead.submitted`, `payment.received`).
   * Returns whatever the handler returns.
   */
  async handle<R = unknown>(
    rawBody: string | Buffer,
    headers: WebhookHeaders,
    handlers: Record<string, WebhookHandler<never, R>>,
  ): Promise<R> {
    const { event, data } = this.verifyAndParse(rawBody, headers);
    const handler = handlers[event];
    if (!handler) {
      throw new WebhookVerificationError(
        `No webhook handler registered for event "${event}"`,
      );
    }
    return handler(data as never, event);
  }
}
