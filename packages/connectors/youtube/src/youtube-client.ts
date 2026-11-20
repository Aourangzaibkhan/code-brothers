/**
 * Client for the YouTube Data API v3
 * (https://developers.google.com/youtube/v3/docs), including the real
 * resumable upload protocol and multipart/related thumbnail uploads.
 *
 * Auth is delegated to an AccessTokenProvider so OAuth refresh logic can
 * live outside this package; every request carries
 * `Authorization: Bearer <token>`. HTTP is injectable for tests.
 */

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export class StaticAccessTokenProvider implements AccessTokenProvider {
  private readonly token: string;
  constructor(tokenOrOptions: string | { accessToken: string }) {
    this.token = typeof tokenOrOptions === 'string' ? tokenOrOptions : tokenOrOptions.accessToken;
    if (!this.token) throw new TypeError('StaticAccessTokenProvider requires an access token');
  }
  async getAccessToken(): Promise<string> {
    return this.token;
  }
}

export class YouTubeApiError extends Error {
  readonly status: number;
  readonly body?: unknown;
  readonly reason?: string;

  constructor(message: string, options: { status: number; body?: unknown; reason?: string }) {
    super(message);
    this.name = 'YouTubeApiError';
    this.status = options.status;
    this.body = options.body;
    this.reason = options.reason;
  }
}

export interface YouTubeDataClientOptions {
  tokenProvider: AccessTokenProvider;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Resumable-upload chunk size in bytes (final chunk may be smaller). */
  chunkSize?: number;
}

export interface UploadVideoInput {
  title: string;
  description?: string;
  tags?: string[];
  privacyStatus?: 'private' | 'public' | 'unlisted' | string;
  categoryId?: string;
  notifySubscribers?: boolean;
  bytes: Uint8Array;
  contentType?: string;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

export class YouTubeDataClient {
  private readonly tokenProvider: AccessTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly chunkSize: number;

  constructor(options: YouTubeDataClientOptions) {
    if (!options.tokenProvider) throw new TypeError('YouTubeDataClient requires a tokenProvider');
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? 'https://www.googleapis.com').replace(/\/+$/, '');
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isFinite(this.chunkSize) || this.chunkSize <= 0) {
      throw new TypeError('chunkSize must be a positive number');
    }
  }

  private async authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.tokenProvider.getAccessToken();
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  private async parseError(response: Response): Promise<YouTubeApiError> {
    const text = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    let message = `YouTube API request failed with HTTP ${response.status}`;
    let reason: string | undefined;
    const errObj =
      parsed && typeof parsed === 'object'
        ? ((parsed as JsonRecord).error as JsonRecord | undefined)
        : undefined;
    if (errObj) {
      if (typeof errObj.message === 'string') message = errObj.message;
      const errors = Array.isArray(errObj.errors) ? errObj.errors : [];
      const first = errors[0] as JsonRecord | undefined;
      if (first && typeof first.reason === 'string') reason = first.reason;
      if (first && typeof first.message === 'string' && typeof errObj.message !== 'string') {
        message = first.message;
      }
    } else if (text) {
      message = `${message}: ${text.slice(0, 200)}`;
    }
    return new YouTubeApiError(message, { status: response.status, body: parsed ?? text, reason });
  }

  private async requestJson<T = JsonRecord>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = await this.authHeaders(
      (init.headers as Record<string, string> | undefined) ?? {},
    );
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (response.status === 204) return {} as T;
    if (!response.ok) throw await this.parseError(response);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * Resumable upload (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol):
   * 1. POST the metadata to /upload/youtube/v3/videos?uploadType=resumable
   *    with X-Upload-Content-Length / X-Upload-Content-Type, read Location.
   * 2. PUT the bytes in chunks with Content-Range headers. On HTTP 308 the
   *    Range response header says how many bytes the server actually has;
   *    resume exactly from that offset.
   * 3. HTTP 200/201 returns the created video resource.
   */
  async uploadVideo(input: UploadVideoInput): Promise<JsonRecord> {
    const contentType = input.contentType ?? 'video/mp4';
    const total = input.bytes.byteLength;
    const snippet: JsonRecord = { title: input.title };
    if (input.description !== undefined) snippet.description = input.description;
    if (input.tags !== undefined) snippet.tags = input.tags;
    if (input.categoryId !== undefined) snippet.categoryId = input.categoryId;
    const status: JsonRecord = {};
    if (input.privacyStatus !== undefined) status.privacyStatus = input.privacyStatus;
    if (input.notifySubscribers !== undefined) status.notifySubscribers = input.notifySubscribers;
    const metadata: JsonRecord = { snippet };
    if (Object.keys(status).length > 0) metadata.status = status;

    const initiateHeaders = await this.authHeaders({
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(total),
      'X-Upload-Content-Type': contentType,
    });
    const initiateUrl =
      `${this.baseUrl}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`;
    const initiateResponse = await this.fetchImpl(initiateUrl, {
      method: 'POST',
      headers: initiateHeaders,
      body: JSON.stringify(metadata),
    });
    if (!initiateResponse.ok) throw await this.parseError(initiateResponse);
    const sessionUri =
      initiateResponse.headers.get('location') ?? initiateResponse.headers.get('Location');
    if (!sessionUri) {
      throw new Error('Resumable upload initiation did not return a Location (session) header');
    }

    let offset = 0;
    // Guard against pathological servers looping 308s forever.
    const maxIterations = Math.ceil(total / 1) + 10_000;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const isFinalisingQuery = total === 0 || offset >= total;
      const chunkEnd = isFinalisingQuery ? offset - 1 : Math.min(offset + this.chunkSize, total) - 1;
      const chunk = isFinalisingQuery
        ? new Uint8Array(0)
        : input.bytes.subarray(offset, chunkEnd + 1);
      const headers: Record<string, string> = {
        'Content-Length': String(chunk.byteLength),
        'Content-Type': contentType,
        'Content-Range': isFinalisingQuery
          ? `bytes */${total}`
          : `bytes ${offset}-${chunkEnd}/${total}`,
      };
      // Session URIs are capability URLs; sending the bearer token again is
      // harmless and matches what Google's own client libraries do.
      headers.Authorization = (await this.authHeaders()).Authorization;
      const response = await this.fetchImpl(sessionUri, {
        method: 'PUT',
        headers,
        body: chunk as RequestInit['body'],
      });
      if (response.status === 200 || response.status === 201) {
        const text = await response.text();
        return (text ? JSON.parse(text) : {}) as JsonRecord;
      }
      if (response.status === 308) {
        const range = response.headers.get('range') ?? response.headers.get('Range');
        let nextOffset: number;
        if (range) {
          // Format: "bytes=0-123" — server has bytes 0..123 inclusive.
          const match = /bytes=(\d+)-(\d+)/.exec(range);
          if (!match) {
            throw new Error(`Unparseable Range header on 308 response: ${range}`);
          }
          nextOffset = Number(match[2]) + 1;
        } else {
          // No Range: assume the whole chunk landed.
          nextOffset = isFinalisingQuery ? total : chunkEnd + 1;
        }
        if (isFinalisingQuery) {
          throw new Error('Upload session still incomplete (308) after all bytes were sent');
        }
        if (nextOffset <= offset) {
          throw new Error(
            `Resumable upload made no progress: server acknowledged offset ${nextOffset}, client was at ${offset}`,
          );
        }
        offset = nextOffset;
        continue;
      }
      throw await this.parseError(response);
    }
    throw new Error('Resumable upload exceeded the maximum number of chunk attempts');
  }

  /**
   * POST /upload/youtube/v3/thumbnails/set?videoId=... with a manually
   * constructed multipart/related body (JSON metadata part + media part).
   */
  async setThumbnail(
    videoId: string,
    imageBytes: Uint8Array,
    contentType = 'image/jpeg',
  ): Promise<JsonRecord> {
    const boundary = `code_brothers_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        '{}\r\n' +
        `--${boundary}\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    );
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.byteLength + imageBytes.byteLength + tail.byteLength);
    body.set(head, 0);
    body.set(imageBytes, head.byteLength);
    body.set(tail, head.byteLength + imageBytes.byteLength);

    const url = `${this.baseUrl}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`;
    const headers = await this.authHeaders({
      'Content-Type': `multipart/related; boundary="${boundary}"`,
      'Content-Length': String(body.byteLength),
    });
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: body as RequestInit['body'],
    });
    if (!response.ok) throw await this.parseError(response);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as JsonRecord;
  }

  /** channels.list (mine) -> uploads playlist -> playlistItems.list. */
  async listMyVideos(maxResults = 50): Promise<JsonRecord[]> {
    const channels = await this.requestJson<JsonRecord & { items?: JsonRecord[] }>(
      '/youtube/v3/channels?part=contentDetails&mine=true',
      { method: 'GET' },
    );
    const first = channels.items?.[0];
    const contentDetails = first?.contentDetails as JsonRecord | undefined;
    const related = contentDetails?.relatedPlaylists as JsonRecord | undefined;
    const uploads = typeof related?.uploads === 'string' ? related.uploads : '';
    if (!uploads) return [];
    const playlist = await this.requestJson<JsonRecord & { items?: JsonRecord[] }>(
      `/youtube/v3/playlistItems?part=snippet,contentDetails,status&playlistId=${encodeURIComponent(uploads)}&maxResults=${maxResults}`,
      { method: 'GET' },
    );
    return playlist.items ?? [];
  }

  /** GET /youtube/v3/commentThreads?part=snippet&videoId=... */
  async listComments(videoId: string, maxResults = 100): Promise<JsonRecord[]> {
    const result = await this.requestJson<JsonRecord & { items?: JsonRecord[] }>(
      `/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&maxResults=${maxResults}`,
      { method: 'GET' },
    );
    return result.items ?? [];
  }

  /** POST /youtube/v3/comments?part=snippet {snippet: {parentId, textOriginal}} */
  async replyToComment(parentCommentId: string, text: string): Promise<JsonRecord> {
    return this.requestJson('/youtube/v3/comments?part=snippet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snippet: { parentId: parentCommentId, textOriginal: text },
      }),
    });
  }

  /**
   * POST /youtube/v3/comments/setModerationStatus?id=...&moderationStatus=...
   * Defaults to 'rejected' (hides the comment); 'heldForReview' also works.
   */
  async hideComment(
    commentId: string,
    moderationStatus: 'rejected' | 'heldForReview' | string = 'rejected',
  ): Promise<JsonRecord> {
    const result = await this.requestJson<JsonRecord>(
      `/youtube/v3/comments/setModerationStatus?id=${encodeURIComponent(commentId)}&moderationStatus=${encodeURIComponent(moderationStatus)}`,
      { method: 'POST' },
    );
    return Object.keys(result).length > 0 ? result : { id: commentId, moderationStatus };
  }
}
