/**
 * Client for the Instagram Content Publishing / Graph API
 * (https://developers.facebook.com/docs/instagram-api/).
 *
 * All requests go to `{baseUrl}/{apiVersion}/...` and carry the page/user
 * access token as the `access_token` query parameter, which is the style
 * the Graph API media endpoints document. HTTP is injectable so tests can
 * run entirely against stubs.
 */

export type InstagramMediaType = 'IMAGE' | 'VIDEO' | 'REELS' | 'STORIES' | 'CAROUSEL';

export interface GraphApiClientOptions {
  igUserId: string;
  accessToken: string;
  fetch?: typeof fetch;
  /** Version path segment, e.g. `v21.0`. */
  apiVersion?: string;
  baseUrl?: string;
  /** Injectable sleep used between container-status polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Default delay between container-status polls (ms). */
  pollIntervalMs?: number;
  /** Default maximum container-status polls before giving up. */
  maxPollAttempts?: number;
}

export interface CreateMediaContainerOptions {
  imageUrl?: string;
  videoUrl?: string;
  mediaType?: InstagramMediaType | string;
  caption?: string;
  /** Child container ids for a CAROUSEL container. */
  children?: string[];
  isCarouselItem?: boolean;
  coverUrl?: string;
  thumbOffset?: number;
  shareToFeed?: boolean;
  locationId?: string;
  altText?: string;
  [key: string]: unknown;
}

export interface PublishMediaOptions extends CreateMediaContainerOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
}

export interface ContainerStatus {
  id?: string;
  status_code?: string;
  status?: string;
  [key: string]: unknown;
}

export class GraphApiError extends Error {
  readonly code?: number;
  readonly status?: number;
  readonly type?: string;
  readonly fbtraceId?: string;
  readonly body?: unknown;

  constructor(
    message: string,
    options: { code?: number; status?: number; type?: string; fbtraceId?: string; body?: unknown } = {},
  ) {
    super(message);
    this.name = 'GraphApiError';
    this.code = options.code;
    this.status = options.status;
    this.type = options.type;
    this.fbtraceId = options.fbtraceId;
    this.body = options.body;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class GraphApiClient {
  readonly igUserId: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;

  constructor(options: GraphApiClientOptions) {
    if (!options.igUserId) throw new TypeError('GraphApiClient requires igUserId');
    if (!options.accessToken) throw new TypeError('GraphApiClient requires accessToken');
    this.igUserId = options.igUserId;
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.apiVersion = options.apiVersion ?? 'v21.0';
    this.baseUrl = (options.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '');
    this.sleepImpl = options.sleep ?? defaultSleep;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.maxPollAttempts = options.maxPollAttempts ?? 30;
  }

  private buildUrl(path: string): string {
    const url = new URL(`${this.baseUrl}/${this.apiVersion}${path}`);
    url.searchParams.set('access_token', this.accessToken);
    return url.toString();
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    const response = await this.fetchImpl(this.buildUrl(path), { ...init, headers });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const errObj =
        parsed && typeof parsed === 'object'
          ? ((parsed as Record<string, unknown>).error as Record<string, unknown> | undefined)
          : undefined;
      throw new GraphApiError(
        typeof errObj?.message === 'string'
          ? errObj.message
          : `Graph API request failed with HTTP ${response.status}`,
        {
          code: typeof errObj?.code === 'number' ? errObj.code : undefined,
          type: typeof errObj?.type === 'string' ? errObj.type : undefined,
          fbtraceId: typeof errObj?.fbtrace_id === 'string' ? errObj.fbtrace_id : undefined,
          status: response.status,
          body: parsed ?? text,
        },
      );
    }
    return (parsed ?? {}) as T;
  }

  private post<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** POST /{ig-user-id}/media — create a media container (unpublished). */
  async createMediaContainer(
    options: CreateMediaContainerOptions,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (options.imageUrl !== undefined) body.image_url = options.imageUrl;
    if (options.videoUrl !== undefined) body.video_url = options.videoUrl;
    if (options.mediaType !== undefined) body.media_type = options.mediaType;
    if (options.caption !== undefined) body.caption = options.caption;
    if (options.children !== undefined) body.children = options.children.join(',');
    if (options.isCarouselItem !== undefined) body.is_carousel_item = options.isCarouselItem;
    if (options.coverUrl !== undefined) body.cover_url = options.coverUrl;
    if (options.thumbOffset !== undefined) body.thumb_offset = options.thumbOffset;
    if (options.shareToFeed !== undefined) body.share_to_feed = options.shareToFeed;
    if (options.locationId !== undefined) body.location_id = options.locationId;
    if (options.altText !== undefined) body.alt_text = options.altText;
    // Pass through any other documented Graph fields the caller supplied.
    const known = new Set([
      'imageUrl', 'videoUrl', 'mediaType', 'caption', 'children', 'isCarouselItem',
      'coverUrl', 'thumbOffset', 'shareToFeed', 'locationId', 'altText',
    ]);
    for (const [key, value] of Object.entries(options)) {
      if (!known.has(key) && value !== undefined) body[key] = value;
    }
    if (body.image_url === undefined && body.video_url === undefined && body.children === undefined) {
      throw new TypeError('createMediaContainer requires imageUrl, videoUrl or children');
    }
    return this.post(`/${encodeURIComponent(this.igUserId)}/media`, body);
  }

  /** GET /{creation-id}?fields=status_code,status */
  async getContainerStatus(creationId: string): Promise<ContainerStatus> {
    return this.request<ContainerStatus>(
      `/${encodeURIComponent(creationId)}?fields=status_code,status`,
      { method: 'GET' },
    );
  }

  /** POST /{ig-user-id}/media_publish {creation_id} */
  async publishContainer(creationId: string): Promise<Record<string, unknown>> {
    return this.post(`/${encodeURIComponent(this.igUserId)}/media_publish`, {
      creation_id: creationId,
    });
  }

  /**
   * Convenience flow: create a container, poll its status until FINISHED
   * (throwing on ERROR / EXPIRED or when attempts run out), then publish.
   */
  async publishMedia(options: PublishMediaOptions): Promise<Record<string, unknown>> {
    const { pollIntervalMs, maxAttempts, ...containerOptions } = options;
    const container = await this.createMediaContainer(containerOptions);
    const creationId = String(container.id ?? '');
    if (!creationId) {
      throw new GraphApiError('Graph API did not return a container id', { body: container });
    }
    const interval = pollIntervalMs ?? this.pollIntervalMs;
    const attempts = maxAttempts ?? this.maxPollAttempts;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const status = await this.getContainerStatus(creationId);
      const code = status.status_code ?? '';
      if (code === 'FINISHED') {
        const published = await this.publishContainer(creationId);
        return { ...published, creation_id: creationId };
      }
      if (code === 'ERROR' || code === 'EXPIRED') {
        throw new GraphApiError(
          `Media container ${creationId} ended in status ${code}${status.status ? `: ${status.status}` : ''}`,
          { body: status },
        );
      }
      if (attempt < attempts - 1) await this.sleepImpl(interval);
    }
    throw new GraphApiError(
      `Media container ${creationId} was not FINISHED after ${attempts} status checks`,
      {},
    );
  }

  /** GET /{ig-user-id}/media?fields=... */
  async listMedia(limit = 25): Promise<Record<string, unknown>> {
    const fields = 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,username';
    return this.request(
      `/${encodeURIComponent(this.igUserId)}/media?fields=${fields}&limit=${limit}`,
      { method: 'GET' },
    );
  }

  /** GET /{media-id}/comments */
  async getComments(mediaId: string): Promise<Record<string, unknown>> {
    const fields = 'id,text,username,timestamp,like_count';
    return this.request(`/${encodeURIComponent(mediaId)}/comments?fields=${fields}`, {
      method: 'GET',
    });
  }

  /** POST /{comment-id}/replies {message} */
  async replyToComment(commentId: string, text: string): Promise<Record<string, unknown>> {
    return this.post(`/${encodeURIComponent(commentId)}/replies`, { message: text });
  }

  /** POST /{comment-id} {hidden} */
  async hideComment(commentId: string, hide = true): Promise<Record<string, unknown>> {
    return this.post(`/${encodeURIComponent(commentId)}`, { hidden: hide });
  }

  /**
   * POST /me/messages — Instagram messaging via the Graph API:
   * {recipient: {id}, messaging_type: 'RESPONSE', message: {text}}.
   * The access token is attached by `request` like every other call.
   */
  async sendDirectMessage(recipientId: string, text: string): Promise<Record<string, unknown>> {
    return this.post('/me/messages', {
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { text },
    });
  }
}
