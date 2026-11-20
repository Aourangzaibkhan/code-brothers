import {
  getPreset,
  type BookingRequest,
  type CourierPreset,
  type NormalizedTracking,
} from './presets.js';

export class CourierApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'CourierApiError';
    this.status = status;
    this.body = body;
  }
}

export interface CourierCredentials {
  apiKey?: string;
  token?: string;
  username?: string;
  password?: string;
}

export interface CourierClientOptions {
  preset: CourierPreset | string;
  credentials: CourierCredentials;
  fetch?: typeof fetch;
  /** Overrides the preset's baseUrl (e.g. a sandbox or a local mock). */
  baseUrl?: string;
}

export interface BookShipmentResult {
  awb: string;
  labelUrl?: string;
  raw: unknown;
}

/** Booking + tracking client driven entirely by a {@link CourierPreset}. */
export class CourierClient {
  readonly preset: CourierPreset;
  private readonly credentials: CourierCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: CourierClientOptions) {
    this.preset =
      typeof options.preset === 'string'
        ? getPreset(options.preset)
        : options.preset;
    this.credentials = options.credentials ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? this.preset.baseUrl).replace(/\/+$/, '');
  }

  /** Auth headers for the preset's declared auth scheme. */
  authHeaders(): Record<string, string> {
    const { auth } = this.preset;
    switch (auth.type) {
      case 'apiKeyHeader': {
        if (!auth.headerName) {
          throw new Error(`Preset ${this.preset.id} is missing auth.headerName`);
        }
        if (!this.credentials.apiKey) {
          throw new Error(
            `Courier ${this.preset.id} requires credentials.apiKey`,
          );
        }
        return { [auth.headerName]: this.credentials.apiKey };
      }
      case 'bearer': {
        if (!this.credentials.token) {
          throw new Error(`Courier ${this.preset.id} requires credentials.token`);
        }
        return { Authorization: `Bearer ${this.credentials.token}` };
      }
      case 'basic': {
        const { username, password } = this.credentials;
        if (!username || !password) {
          throw new Error(
            `Courier ${this.preset.id} requires credentials.username + credentials.password`,
          );
        }
        const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
        return { Authorization: `Basic ${token}` };
      }
    }
  }

  private async requestJson(
    method: string,
    path: string,
    query: Record<string, string> | undefined,
    body: unknown,
  ): Promise<unknown> {
    const qs = query ? new URLSearchParams(query).toString() : '';
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.authHeaders(),
    };
    let bodyText: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyText = JSON.stringify(body);
    }
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: bodyText,
    });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new CourierApiError(
        `${this.preset.name} request failed with HTTP ${response.status}`,
        response.status,
        text,
      );
    }
    if (text === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  /** Book a shipment; resolves with the parsed AWB/label plus the raw body. */
  async bookShipment(req: BookingRequest): Promise<BookShipmentResult> {
    const payload = this.preset.mapBooking(req);
    const raw = await this.requestJson(
      this.preset.booking.method,
      this.preset.booking.path,
      undefined,
      payload,
    );
    const parsed = this.preset.parseBookingResponse(raw);
    return { ...parsed, raw };
  }

  /** Track a shipment by AWB; resolves with the normalized tracking shape. */
  async track(awb: string): Promise<NormalizedTracking> {
    const trackingReq = this.preset.buildTrackingRequest(awb);
    const path = trackingReq.path.includes('{awb}')
      ? trackingReq.path.replace('{awb}', encodeURIComponent(awb))
      : trackingReq.path;
    const method = this.preset.tracking.method.toUpperCase();
    const raw = await this.requestJson(
      method,
      path,
      trackingReq.query,
      method === 'POST' ? { awb, trackingNumber: awb } : undefined,
    );
    const parsed = this.preset.parseTracking(raw);
    return { ...parsed, awb: parsed.awb || awb };
  }
}
