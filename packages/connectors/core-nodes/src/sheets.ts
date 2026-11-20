/**
 * Minimal Google Sheets v4 client (values append + read) with an injectable
 * fetch and either a static access token or an async token provider.
 */

export class GoogleSheetsApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'GoogleSheetsApiError';
    this.status = status;
    this.body = body;
  }
}

export interface GoogleSheetsClientOptions {
  spreadsheetId: string;
  accessToken?: string;
  tokenProvider?: { getAccessToken(): Promise<string> };
  fetch?: typeof fetch;
}

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export class GoogleSheetsClient {
  private readonly spreadsheetId: string;
  private readonly accessToken?: string;
  private readonly tokenProvider?: { getAccessToken(): Promise<string> };
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleSheetsClientOptions) {
    this.spreadsheetId = options.spreadsheetId;
    this.accessToken = options.accessToken;
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async resolveToken(): Promise<string> {
    if (this.tokenProvider) return this.tokenProvider.getAccessToken();
    if (this.accessToken) return this.accessToken;
    throw new Error(
      'GoogleSheetsClient requires an accessToken or a tokenProvider',
    );
  }

  private async request(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = await this.resolveToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    let bodyText: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyText = JSON.stringify(body);
    }
    const response = await this.fetchImpl(url, { method, headers, body: bodyText });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new GoogleSheetsApiError(
        `Google Sheets request failed with HTTP ${response.status}`,
        response.status,
        text,
      );
    }
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  }

  /**
   * Append rows to a range:
   * `POST /v4/spreadsheets/{id}/values/{range}:append?valueInputOption=USER_ENTERED`
   */
  async appendValues(
    range: string,
    values: unknown[][],
  ): Promise<unknown> {
    const url =
      `${SHEETS_BASE}/${encodeURIComponent(this.spreadsheetId)}` +
      `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
    return this.request('POST', url, {
      range,
      majorDimension: 'ROWS',
      values,
    });
  }

  /** Read the values of a range. Resolves with the API's values response. */
  async getValues(range: string): Promise<unknown> {
    const url =
      `${SHEETS_BASE}/${encodeURIComponent(this.spreadsheetId)}` +
      `/values/${encodeURIComponent(range)}`;
    return this.request('GET', url);
  }
}
