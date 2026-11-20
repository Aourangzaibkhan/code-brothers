import { createHmac, randomBytes } from 'node:crypto';

/**
 * WooCommerce REST API client (default API version `v3`).
 *
 * - `https://` stores authenticate with HTTP Basic auth
 *   (`Authorization: Basic base64(consumerKey:consumerSecret)`).
 * - `http://` stores cannot use Basic auth safely, so requests are signed
 *   with WooCommerce's one-legged OAuth 1.0a scheme: the OAuth parameters
 *   travel in the query string and `oauth_signature` is
 *   `base64(HMAC-SHA256(key = consumerSecret + '&', baseString))` where
 *   `baseString = METHOD & encode(url-without-query) &
 *   encode(sorted-normalized-parameters)`.
 */

export class WooCommerceApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'WooCommerceApiError';
    this.code = code;
    this.status = status;
  }
}

export interface WooCommerceClientOptions {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  fetch?: typeof fetch;
  /** REST API version namespace, default `v3`. */
  version?: string;
  /** Injectable nonce source (tests pin it for deterministic signatures). */
  nonceFn?: () => string;
  /** Injectable clock returning epoch **seconds** (tests pin it). */
  now?: () => number;
}

/** RFC 3986 percent-encoding as required by OAuth 1.0a. */
export function oauthEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Compute the OAuth 1.0a signature for a request. Exported for inspection;
 * the known-answer tests deliberately do NOT use this to build expectations.
 */
export function computeOAuthSignature(input: {
  method: string;
  /** URL without any query string. */
  url: string;
  /** All parameters to sign: query params + oauth_* params (no signature). */
  params: Record<string, string>;
  consumerSecret: string;
}): string {
  const normalized = Object.entries(input.params)
    .map(([k, v]) => [oauthEncode(k), oauthEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) =>
      ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const baseString = [
    input.method.toUpperCase(),
    oauthEncode(input.url),
    oauthEncode(normalized),
  ].join('&');
  const signingKey = `${oauthEncode(input.consumerSecret)}&`;
  return createHmac('sha256', signingKey).update(baseString).digest('base64');
}

export class WooCommerceClient {
  private readonly storeUrl: string;
  private readonly consumerKey: string;
  private readonly consumerSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly version: string;
  private readonly nonceFn: () => string;
  private readonly now: () => number;

  constructor(options: WooCommerceClientOptions) {
    this.storeUrl = options.storeUrl.replace(/\/+$/, '');
    this.consumerKey = options.consumerKey;
    this.consumerSecret = options.consumerSecret;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.version = options.version ?? 'v3';
    this.nonceFn =
      options.nonceFn ?? (() => randomBytes(16).toString('hex'));
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get baseUrl(): string {
    return `${this.storeUrl}/wp-json/wc/${this.version}`;
  }

  private get isHttps(): boolean {
    return this.storeUrl.toLowerCase().startsWith('https://');
  }

  /** Build the final request URL, applying Basic auth or OAuth signing. */
  private buildRequest(
    method: string,
    path: string,
    queryParams: Record<string, string> = {},
  ): { url: string; headers: Record<string, string> } {
    const urlWithoutQuery = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.isHttps) {
      const token = Buffer.from(
        `${this.consumerKey}:${this.consumerSecret}`,
        'utf8',
      ).toString('base64');
      headers.Authorization = `Basic ${token}`;
      const qs = new URLSearchParams(queryParams).toString();
      return { url: qs ? `${urlWithoutQuery}?${qs}` : urlWithoutQuery, headers };
    }
    const oauthParams: Record<string, string> = {
      oauth_consumer_key: this.consumerKey,
      oauth_nonce: this.nonceFn(),
      oauth_timestamp: String(this.now()),
      oauth_signature_method: 'HMAC-SHA256',
    };
    const allParams = { ...queryParams, ...oauthParams };
    const signature = computeOAuthSignature({
      method,
      url: urlWithoutQuery,
      params: allParams,
      consumerSecret: this.consumerSecret,
    });
    const qs = new URLSearchParams({
      ...allParams,
      oauth_signature: signature,
    }).toString();
    return { url: `${urlWithoutQuery}?${qs}`, headers };
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, unknown>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) query[key] = String(value);
    }
    const { url, headers } = this.buildRequest(method, path, query);
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const wooError =
        parsed && typeof parsed === 'object'
          ? (parsed as { code?: unknown; message?: unknown })
          : {};
      const code =
        typeof wooError.code === 'string'
          ? wooError.code
          : `http_${response.status}`;
      const message =
        typeof wooError.message === 'string'
          ? wooError.message
          : `WooCommerce request failed with HTTP ${response.status}`;
      throw new WooCommerceApiError(message, code, response.status);
    }
    return parsed as T;
  }

  getOrders<T = unknown>(params: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>('GET', '/orders', { query: params });
  }

  getOrder<T = unknown>(id: string | number): Promise<T> {
    return this.request<T>('GET', `/orders/${id}`);
  }

  getProducts<T = unknown>(params: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>('GET', '/products', { query: params });
  }

  getProduct<T = unknown>(id: string | number): Promise<T> {
    return this.request<T>('GET', `/products/${id}`);
  }

  /** Set a product's stock quantity (enables stock management). */
  updateProductStock<T = unknown>(
    productId: string | number,
    stockQuantity: number,
  ): Promise<T> {
    return this.request<T>('PUT', `/products/${productId}`, {
      body: { stock_quantity: stockQuantity, manage_stock: true },
    });
  }

  createOrder<T = unknown>(order: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', '/orders', { body: order });
  }
}
