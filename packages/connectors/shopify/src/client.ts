/**
 * Shopify Admin REST API client (real API shapes, injectable fetch).
 *
 * Base: https://{shop}/admin/api/{apiVersion}
 * Auth: `X-Shopify-Access-Token: <accessToken>` on every request.
 * Docs shape reference: Shopify Admin API (REST), default version 2024-10.
 */

export interface ShopifyClientOptions {
  /** Bare shop domain, e.g. `mystore.myshopify.com` (a URL prefix is tolerated). */
  shop: string;
  accessToken: string;
  fetch?: typeof fetch;
  apiVersion?: string;
  /** Full REST base override (mainly for tests), e.g. `https://example.test/admin/api/2024-10`. */
  baseUrl?: string;
}

export class ShopifyApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Shopify API error (HTTP ${status}): ${body}`);
    this.name = 'ShopifyApiError';
    this.status = status;
    this.body = body;
  }
}

type QueryValue = string | number | boolean | undefined | null;
export type ShopifyQuery = Record<string, QueryValue>;

function normalizeShop(shop: string): string {
  return shop.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

export class ShopifyClient {
  readonly shop: string;
  readonly apiVersion: string;
  readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ShopifyClientOptions) {
    if (!options.shop) throw new Error('ShopifyClient requires a shop domain');
    if (!options.accessToken) throw new Error('ShopifyClient requires an accessToken');
    this.shop = normalizeShop(options.shop);
    this.accessToken = options.accessToken;
    this.apiVersion = options.apiVersion ?? '2024-10';
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = (
      options.baseUrl ?? `https://${this.shop}/admin/api/${this.apiVersion}`
    ).replace(/\/$/, '');
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: ShopifyQuery,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ShopifyApiError(response.status, text);
    }
    if (text === '') return undefined as T;
    return JSON.parse(text) as T;
  }

  // ---- Products -----------------------------------------------------------

  async getProducts(params: ShopifyQuery = {}): Promise<unknown[]> {
    const res = await this.request<{ products: unknown[] }>('GET', '/products.json', undefined, params);
    return res.products ?? [];
  }

  async getProduct(id: string | number): Promise<unknown> {
    const res = await this.request<{ product: unknown }>('GET', `/products/${id}.json`);
    return res.product;
  }

  async createProduct(product: Record<string, unknown>): Promise<unknown> {
    const res = await this.request<{ product: unknown }>('POST', '/products.json', { product });
    return res.product;
  }

  async updateProduct(id: string | number, product: Record<string, unknown>): Promise<unknown> {
    const res = await this.request<{ product: unknown }>('PUT', `/products/${id}.json`, {
      product: { id, ...product },
    });
    return res.product;
  }

  // ---- Orders -------------------------------------------------------------

  async getOrders(params: ShopifyQuery = {}): Promise<unknown[]> {
    const res = await this.request<{ orders: unknown[] }>('GET', '/orders.json', undefined, params);
    return res.orders ?? [];
  }

  async getOrder(id: string | number): Promise<unknown> {
    const res = await this.request<{ order: unknown }>('GET', `/orders/${id}.json`);
    return res.order;
  }

  async updateOrder(id: string | number, fields: Record<string, unknown>): Promise<unknown> {
    const res = await this.request<{ order: unknown }>('PUT', `/orders/${id}.json`, {
      order: { id, ...fields },
    });
    return res.order;
  }

  async createDraftOrder(draftOrder: Record<string, unknown>): Promise<unknown> {
    const res = await this.request<{ draft_order: unknown }>('POST', '/draft_orders.json', {
      draft_order: draftOrder,
    });
    return res.draft_order;
  }

  // ---- Fulfillments (fulfillment-orders flow) ------------------------------

  async createFulfillment(
    orderId: string | number,
    input: {
      fulfillmentOrderId: string | number;
      lineItems?: Array<{ id: string | number; quantity: number }>;
      trackingNumber?: string;
      trackingCompany?: string;
      trackingUrl?: string;
      notifyCustomer?: boolean;
    },
  ): Promise<unknown> {
    if (input.fulfillmentOrderId === undefined || input.fulfillmentOrderId === null) {
      throw new Error('createFulfillment requires fulfillmentOrderId (fulfillment-orders flow)');
    }
    void orderId; // The fulfillment-orders flow keys off fulfillment_order_id, not the order id.
    const fulfillmentOrderEntry: Record<string, unknown> = {
      fulfillment_order_id: input.fulfillmentOrderId,
    };
    if (input.lineItems && input.lineItems.length > 0) {
      fulfillmentOrderEntry.fulfillment_order_line_items = input.lineItems;
    }
    const fulfillment: Record<string, unknown> = {
      line_items_by_fulfillment_order: [fulfillmentOrderEntry],
    };
    if (input.trackingNumber !== undefined || input.trackingCompany !== undefined || input.trackingUrl !== undefined) {
      const trackingInfo: Record<string, unknown> = {};
      if (input.trackingNumber !== undefined) trackingInfo.number = input.trackingNumber;
      if (input.trackingCompany !== undefined) trackingInfo.company = input.trackingCompany;
      if (input.trackingUrl !== undefined) trackingInfo.url = input.trackingUrl;
      fulfillment.tracking_info = trackingInfo;
    }
    if (input.notifyCustomer !== undefined) fulfillment.notify_customer = input.notifyCustomer;
    const res = await this.request<{ fulfillment: unknown }>('POST', '/fulfillments.json', { fulfillment });
    return res.fulfillment;
  }

  // ---- Inventory ----------------------------------------------------------

  async getInventoryLevels(params: {
    inventoryItemIds?: Array<string | number>;
    locationIds?: Array<string | number>;
  } = {}): Promise<unknown[]> {
    const query: ShopifyQuery = {};
    if (params.inventoryItemIds?.length) query.inventory_item_ids = params.inventoryItemIds.join(',');
    if (params.locationIds?.length) query.location_ids = params.locationIds.join(',');
    const res = await this.request<{ inventory_levels: unknown[] }>('GET', '/inventory_levels.json', undefined, query);
    return res.inventory_levels ?? [];
  }

  async setInventoryLevel(input: {
    locationId: string | number;
    inventoryItemId: string | number;
    available: number;
  }): Promise<unknown> {
    const res = await this.request<{ inventory_level: unknown }>('POST', '/inventory_levels/set.json', {
      location_id: input.locationId,
      inventory_item_id: input.inventoryItemId,
      available: input.available,
    });
    return res.inventory_level;
  }

  async adjustInventoryLevel(input: {
    locationId: string | number;
    inventoryItemId: string | number;
    availableAdjustQuantity: number;
  }): Promise<unknown> {
    const res = await this.request<{ inventory_level: unknown }>('POST', '/inventory_levels/adjust.json', {
      location_id: input.locationId,
      inventory_item_id: input.inventoryItemId,
      available_adjustment: input.availableAdjustQuantity,
    });
    return res.inventory_level;
  }

  // ---- GraphQL ------------------------------------------------------------

  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const payload = await this.request<{ data?: T; errors?: unknown[] }>(
      'POST',
      '/graphql.json',
      variables !== undefined ? { query, variables } : { query },
    );
    if (payload && Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new ShopifyApiError(200, JSON.stringify(payload.errors), `Shopify GraphQL errors: ${JSON.stringify(payload.errors)}`);
    }
    return payload.data as T;
  }
}
