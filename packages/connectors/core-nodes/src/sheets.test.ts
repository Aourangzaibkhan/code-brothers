import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestNodeContext } from '@code-brothers/node-sdk';
import { GoogleSheetsClient } from './sheets.js';
import { googleSheetsAppendNode } from './nodes.js';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(responseBody: unknown, status = 200) {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

describe('GoogleSheetsClient.appendValues', () => {
  it('POSTs to the encoded-range :append URL with auth + ROWS body', async () => {
    const { fetchImpl, calls } = stubFetch({
      spreadsheetId: 'sheet-123',
      updates: { updatedRows: 2 },
    });
    const client = new GoogleSheetsClient({
      spreadsheetId: 'sheet-123',
      accessToken: 'ya29.test-token',
      fetch: fetchImpl,
    });
    await client.appendValues('Sheet1!A1:B2', [
      ['Ada', 36],
      ['Grace', 85],
    ]);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      'https://sheets.googleapis.com/v4/spreadsheets/sheet-123/values/Sheet1!A1%3AB2:append?valueInputOption=USER_ENTERED',
    );
    assert.equal(calls[0]?.init.method, 'POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer ya29.test-token');
    assert.deepEqual(JSON.parse(calls[0]?.init.body as string), {
      range: 'Sheet1!A1:B2',
      majorDimension: 'ROWS',
      values: [
        ['Ada', 36],
        ['Grace', 85],
      ],
    });
  });

  it('getValues uses a tokenProvider when given', async () => {
    const { fetchImpl, calls } = stubFetch({ values: [['x']] });
    const client = new GoogleSheetsClient({
      spreadsheetId: 's1',
      tokenProvider: { getAccessToken: async () => 'provider-token' },
      fetch: fetchImpl,
    });
    const result = (await client.getValues('A1')) as { values: string[][] };
    assert.deepEqual(result.values, [['x']]);
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer provider-token');
    assert.equal(calls[0]?.init.method, 'GET');
  });
});

describe('googleSheetsAppend node (stub fetch)', () => {
  it('parses valuesJson and appends through ctx.fetch + credential token', async () => {
    const { fetchImpl, calls } = stubFetch({ updates: { updatedRows: 1 } });
    const { ctx } = createTestNodeContext({
      parameters: {
        spreadsheetId: 'sheet-9',
        range: 'Data!A:C',
        valuesJson: '[["a","b","c"]]',
      },
      credentials: { googleSheets: { accessToken: 'node-token' } },
      fetchImpl,
    });
    const [out] = await googleSheetsAppendNode.execute(ctx, [{ json: {} }]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.url.includes('/spreadsheets/sheet-9/values/Data!A%3AC:append'));
    assert.ok(calls[0]?.url.includes('valueInputOption=USER_ENTERED'));
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer node-token');
    assert.equal(out?.[0]?.json.spreadsheetId, 'sheet-9');
    assert.equal(out?.[0]?.json.range, 'Data!A:C');
  });
});
