import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudApiClient, WhatsAppApiError } from './cloud-client.js';
import { AntiBanCapError, AntiBanQueue } from './anti-ban.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(
  responder: (req: CapturedRequest) => { status?: number; json: unknown },
) {
  const calls: CapturedRequest[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const req: CapturedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    };
    calls.push(req);
    const { status = 200, json } = responder(req);
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const okResponder = () => ({ json: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.999' }] } });

function makeClient(fetchImpl: never, extra = {}) {
  return new CloudApiClient({
    phoneNumberId: 'PN123',
    accessToken: 'EAATOKEN',
    fetch: fetchImpl,
    ...extra,
  });
}

test('sendText posts the real Graph API payload shape', async () => {
  const { fetchImpl, calls } = stubFetch(okResponder);
  const client = makeClient(fetchImpl as never);
  const result = await client.sendText('923001234567', 'Salam! Your order is confirmed.');
  assert.equal(result.messageId, 'wamid.999');
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, 'https://graph.facebook.com/v21.0/PN123/messages');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Authorization'], 'Bearer EAATOKEN');
  assert.deepEqual(call.body, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '923001234567',
    type: 'text',
    text: { body: 'Salam! Your order is confirmed.', preview_url: false },
  });
});

test('sendTemplate posts template name, language and components', async () => {
  const { fetchImpl, calls } = stubFetch(okResponder);
  const client = makeClient(fetchImpl as never);
  await client.sendTemplate('923001234567', 'order_update', 'ur_PK', [
    { type: 'body', parameters: [{ type: 'text', text: 'CB-1001' }] },
  ]);
  assert.deepEqual(calls[0]!.body, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '923001234567',
    type: 'template',
    template: {
      name: 'order_update',
      language: { code: 'ur_PK' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'CB-1001' }] }],
    },
  });
});

test('sendMedia supports link and media-id sources with captions', async () => {
  const { fetchImpl, calls } = stubFetch(okResponder);
  const client = makeClient(fetchImpl as never);
  await client.sendMedia('923001234567', 'image', { link: 'https://cdn.example.com/a.jpg' }, { caption: 'Your invoice' });
  assert.deepEqual(calls[0]!.body, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '923001234567',
    type: 'image',
    image: { link: 'https://cdn.example.com/a.jpg', caption: 'Your invoice' },
  });
  await client.sendMedia('923001234567', 'document', { mediaId: 'M77' }, { filename: 'invoice.pdf' });
  const doc = calls[1]!.body as { document: Record<string, unknown> };
  assert.deepEqual(doc.document, { id: 'M77', filename: 'invoice.pdf' });
  await assert.rejects(client.sendMedia('923001234567', 'image', {}), /link or a mediaId/);
});

test('getMediaUrl resolves the download URL for a media id', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({
    json: { url: 'https://lookaside.example.com/dl/abc', mime_type: 'image/jpeg', sha256: 'ff00', file_size: 1234 },
  }));
  const client = makeClient(fetchImpl as never);
  const media = await client.getMediaUrl('MEDIA42');
  assert.equal(calls[0]!.url, 'https://graph.facebook.com/v21.0/MEDIA42');
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(media.url, 'https://lookaside.example.com/dl/abc');
  assert.equal(media.mimeType, 'image/jpeg');
  assert.equal(media.fileSize, 1234);
});

test('Graph API errors surface as WhatsAppApiError with code and status', async () => {
  const { fetchImpl } = stubFetch(() => ({
    status: 400,
    json: { error: { message: 'Invalid OAuth access token', code: 190 } },
  }));
  const client = makeClient(fetchImpl as never);
  await assert.rejects(client.sendText('923001234567', 'hi'), (err: unknown) => {
    assert.ok(err instanceof WhatsAppApiError);
    assert.equal(err.status, 400);
    assert.equal(err.code, 190);
    assert.match(err.message, /Invalid OAuth/);
    return true;
  });
});

test('sends are paced through the anti-ban queue when configured', async () => {
  const { fetchImpl, calls } = stubFetch(okResponder);
  const queue = new AntiBanQueue({ dailyCap: 1, minIntervalMs: 0, maxJitterMs: 0 });
  const client = makeClient(fetchImpl as never, { antiBan: queue });
  await client.sendText('923001234567', 'first');
  await assert.rejects(client.sendText('923001234567', 'second'), AntiBanCapError);
  assert.equal(calls.length, 1); // the capped send never hit the API
  assert.equal(queue.getDailyCount('PN123'), 1);
});
