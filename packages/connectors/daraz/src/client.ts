import { signDarazRequest } from './sign.js';

/**
 * Daraz Open Platform client (Lazada-style signing; real endpoints/shapes).
 *
 * REST base per country, e.g. Pakistan: https://api.daraz.pk/rest
 * Every call carries signed system params (app_key, timestamp in ms,
 * sign_method=sha256, access_token when present) in the QUERY STRING for
 * both GET and POST (Daraz style); some POST APIs additionally take a
 * `payload` parameter (e.g. product updates, as XML).
 *
 * Token refresh endpoint decision: the real Lazada/Daraz token endpoint
 * lives on a separate auth host under `/rest/oauth2/refresh_token`.
 * `refreshAccessToken` therefore POSTs to
 *   (authBaseUrl ?? baseUrl-without-trailing-/rest) + '/rest/oauth2/refresh_token'
 * signed with the signing path '/oauth2/refresh_token'. `authBaseUrl` is
 * configurable so deployments can point at their country's auth host.
 */

export type DarazCountry = 'pk' | 'bd' | 'lk' | 'np' | 'mm';

export const DARAZ_BASE_URLS: Record<DarazCountry, string> = {
  pk: 'https://api.daraz.pk/rest',
  bd: 'https://api.daraz.com.bd/rest',
  lk: 'https://api.daraz.lk/rest',
  np: 'https://api.daraz.com.np/rest',
  mm: 'https://api.daraz.com.mm/rest',
};

export interface DarazClientOptions {
  appKey: string;
  appSecret: string;
  accessToken?: string;
  country?: DarazCountry;
  fetch?: typeof fetch;
  /** REST base override (tests / non-standard deployments). */
  baseUrl?: string;
  /** Auth host override for refreshAccessToken, e.g. `https://auth.daraz.pk`. */
  authBaseUrl?: string;
  /** Injectable clock returning ms since epoch (defaults to Date.now). */
  now?: () => number;
}

export class DarazApiError extends Error {
  readonly code: string;
  readonly body: string;
  constructor(code: string, message: string, body = '') {
    super(`Daraz API error (code ${code}): ${message}`);
    this.name = 'DarazApiError';
    this.code = code;
    this.body = body;
  }
}

function toParamRecord(input: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : String(value);
  }
  return out;
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface DarazTokenPayload {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  [key: string]: unknown;
}

export class DarazClient {
  readonly appKey: string;
  readonly country: DarazCountry;
  readonly baseUrl: string;
  readonly authBaseUrl?: string;
  private readonly appSecret: string;
  private readonly accessToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: DarazClientOptions) {
    if (!options.appKey) throw new Error('DarazClient requires an appKey');
    if (!options.appSecret) throw new Error('DarazClient requires an appSecret');
    this.appKey = options.appKey;
    this.appSecret = options.appSecret;
    this.accessToken = options.accessToken;
    this.country = options.country ?? 'pk';
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.baseUrl = (options.baseUrl ?? DARAZ_BASE_URLS[this.country]).replace(/\/$/, '');
    this.authBaseUrl = options.authBaseUrl?.replace(/\/$/, '');
  }

  /** System params + API params, fully signed. Exported for tests/debugging. */
  buildSignedParams(apiPath: string, apiParams: Record<string, unknown> = {}): Record<string, string> {
    const params: Record<string, string> = {
      ...toParamRecord(apiParams),
      app_key: this.appKey,
      timestamp: String(this.now()),
      sign_method: 'sha256',
    };
    if (this.accessToken) params.access_token = this.accessToken;
    params.sign = signDarazRequest(apiPath, params, this.appSecret);
    return params;
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      if (!response.ok) throw new DarazApiError(String(response.status), text, text);
      return text;
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (obj.code !== undefined && String(obj.code) !== '0') {
        throw new DarazApiError(
          String(obj.code),
          String(obj.message ?? obj.msg ?? 'Unknown Daraz error'),
          text,
        );
      }
      if ('data' in obj) return obj.data;
      return obj;
    }
    return parsed;
  }

  async apiCall(
    apiPath: string,
    apiParams: Record<string, unknown> = {},
    options: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<unknown> {
    const signed = this.buildSignedParams(apiPath, apiParams);
    const url = `${this.baseUrl}${apiPath}?${new URLSearchParams(signed).toString()}`;
    const method = options.method ?? 'GET';
    const init: RequestInit = {
      method,
      headers: { Accept: 'application/json' },
    };
    if (options.body !== undefined) {
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    const response = await this.fetchImpl(url, init);
    if (!response.ok && response.status >= 500) {
      const text = await response.text();
      throw new DarazApiError(String(response.status), text, text);
    }
    return this.parseResponse(response);
  }

  // ---- Orders ---------------------------------------------------------------

  async getOrders(params: {
    createdAfter?: string;
    createdBefore?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<unknown> {
    return this.apiCall('/orders/get', {
      created_after: params.createdAfter,
      created_before: params.createdBefore,
      status: params.status,
      limit: params.limit,
      offset: params.offset,
    });
  }

  async getOrderItems(orderId: string | number): Promise<unknown> {
    return this.apiCall('/orders/items/get', { order_id: String(orderId) });
  }

  // ---- OAuth ----------------------------------------------------------------

  async refreshAccessToken(refreshToken: string): Promise<DarazTokenPayload> {
    const signingPath = '/oauth2/refresh_token';
    const signed = this.buildSignedParams(signingPath, { refresh_token: refreshToken });
    const authRoot = this.authBaseUrl ?? this.baseUrl.replace(/\/rest$/, '');
    const url = `${authRoot}/rest${signingPath}?${new URLSearchParams(signed).toString()}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const result = await this.parseResponse(response);
    return result as DarazTokenPayload;
  }

  // ---- Products -------------------------------------------------------------

  async updateProductItem(input: {
    sellerSku: string;
    quantity?: number;
    price?: number;
    salePrice?: number;
    saleStart?: string;
    saleEnd?: string;
  }): Promise<unknown> {
    const fields: Array<[string, string | number | undefined]> = [
      ['SellerSku', input.sellerSku],
      ['Quantity', input.quantity],
      ['Price', input.price],
      ['SalePrice', input.salePrice],
      ['SaleStartDate', input.saleStart],
      ['SaleEndDate', input.saleEnd],
    ];
    const skuXml = fields
      .filter(([, v]) => v !== undefined)
      .map(([tag, v]) => `<${tag}>${xmlEscape(String(v))}</${tag}>`)
      .join('');
    const payload =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Request><Product><Skus><Sku>${skuXml}</Sku></Skus></Product></Request>`;
    return this.apiCall('/product/item/update', { payload }, { method: 'POST' });
  }

  async updateStock(sellerSku: string, quantity: number): Promise<unknown> {
    return this.updateProductItem({ sellerSku, quantity });
  }

  async updatePrice(input: {
    sellerSku: string;
    price: number;
    salePrice?: number;
    saleStart?: string;
    saleEnd?: string;
  }): Promise<unknown> {
    return this.updateProductItem(input);
  }
}
