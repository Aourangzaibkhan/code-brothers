import { AntiBanQueue } from './anti-ban.js';
import type { FetchLike } from './types.js';

export class WhatsAppApiError extends Error {
  readonly status: number;
  readonly code?: number;
  constructor(status: number, message: string, code?: number) {
    super(message);
    this.name = 'WhatsAppApiError';
    this.status = status;
    this.code = code;
  }
}

export interface CloudApiOptions {
  phoneNumberId: string;
  accessToken: string;
  fetch?: FetchLike;
  /** Graph API base URL (default https://graph.facebook.com). */
  baseUrl?: string;
  /** Graph API version segment (default v21.0). */
  apiVersion?: string;
  /**
   * When provided, every outbound send is paced through this queue using
   * `antiBanKey` (defaults to the phone number id) as the sender key.
   */
  antiBan?: AntiBanQueue;
  antiBanKey?: string;
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  parameters?: Array<Record<string, unknown>>;
  sub_type?: string;
  index?: string | number;
}

export interface SendResult {
  messageId: string;
  to: string;
  raw: Record<string, unknown>;
}

interface GraphErrorBody {
  error?: { message?: string; code?: number };
}

/**
 * WhatsApp Cloud API (Meta Graph API) client.
 *
 * Payloads follow the real Graph API shapes for
 * POST /{version}/{phone-number-id}/messages. All sends can optionally be
 * routed through an AntiBanQueue.
 */
export class CloudApiClient {
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly antiBan?: AntiBanQueue;
  private readonly antiBanKey: string;

  constructor(options: CloudApiOptions) {
    this.phoneNumberId = options.phoneNumberId;
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
    this.baseUrl = (options.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '');
    this.apiVersion = options.apiVersion ?? 'v21.0';
    this.antiBan = options.antiBan;
    this.antiBanKey = options.antiBanKey ?? options.phoneNumberId;
  }

  private async request(
    path: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = (await response.json().catch(() => ({}))) as GraphErrorBody &
      Record<string, unknown>;
    if (!response.ok || body.error) {
      throw new WhatsAppApiError(
        response.status,
        body.error?.message ?? `WhatsApp API request failed (${response.status})`,
        body.error?.code,
      );
    }
    return body;
  }

  /** POST a messages payload, paced through the anti-ban queue if set. */
  private async postMessage(
    payload: Record<string, unknown>,
  ): Promise<SendResult> {
    const send = async (): Promise<SendResult> => {
      const body = await this.request(
        `/${this.apiVersion}/${this.phoneNumberId}/messages`,
        { method: 'POST', body: JSON.stringify(payload) },
      );
      const messages = body['messages'] as Array<{ id?: string }> | undefined;
      return {
        messageId: messages?.[0]?.id ?? '',
        to: String(payload['to'] ?? ''),
        raw: body,
      };
    };
    return this.antiBan ? this.antiBan.enqueue(this.antiBanKey, send) : send();
  }

  /** Send a plain text message. */
  async sendText(
    to: string,
    body: string,
    options: { previewUrl?: boolean } = {},
  ): Promise<SendResult> {
    return this.postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: options.previewUrl ?? false },
    });
  }

  /** Send an approved template message (required outside the 24h window). */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode = 'en_US',
    components?: TemplateComponent[],
  ): Promise<SendResult> {
    return this.postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {}),
      },
    });
  }

  /** Send an image/video/document/audio message by link or uploaded media id. */
  async sendMedia(
    to: string,
    kind: 'image' | 'video' | 'document' | 'audio',
    source: { link?: string; mediaId?: string },
    options: { caption?: string; filename?: string } = {},
  ): Promise<SendResult> {
    if (!source.link && !source.mediaId) {
      throw new Error('sendMedia requires either a link or a mediaId');
    }
    const media: Record<string, unknown> = {};
    if (source.link) media['link'] = source.link;
    if (source.mediaId) media['id'] = source.mediaId;
    if (options.caption && kind !== 'audio') media['caption'] = options.caption;
    if (options.filename && kind === 'document') media['filename'] = options.filename;
    return this.postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: kind,
      [kind]: media,
    });
  }

  /** Mark an incoming message as read (blue ticks). */
  async markAsRead(messageId: string): Promise<void> {
    await this.request(`/${this.apiVersion}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  }

  /** Resolve a temporary download URL for a received media id. */
  async getMediaUrl(
    mediaId: string,
  ): Promise<{ url: string; mimeType?: string; sha256?: string; fileSize?: number }> {
    const body = await this.request(`/${this.apiVersion}/${mediaId}`, {
      method: 'GET',
    });
    return {
      url: String(body['url'] ?? ''),
      mimeType: body['mime_type'] as string | undefined,
      sha256: body['sha256'] as string | undefined,
      fileSize: body['file_size'] as number | undefined,
    };
  }
}
