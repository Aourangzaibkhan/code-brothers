import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestNodeContext, NodeRegistry } from '@code-brothers/node-sdk';
import { registerWhatsAppNodes, whatsappNodes } from './nodes.js';

function graphFetch(calls: Array<{ url: string; body: unknown }>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    return new Response(
      JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.NODE1' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

const credentials = {
  whatsappCloud: { phoneNumberId: 'PN123', accessToken: 'EAATOKEN' },
};

test('registerWhatsAppNodes registers both node types', () => {
  const registry = new NodeRegistry();
  registerWhatsAppNodes(registry);
  assert.deepEqual(registry.types().sort(), [
    'whatsapp.downloadMedia',
    'whatsapp.sendMessage',
    'whatsapp.sendTemplate',
  ]);
  assert.equal(whatsappNodes.length, 3);
});

test('whatsapp.sendMessage executes through a test context', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const { ctx } = createTestNodeContext({
    parameters: { to: '923001234567', body: 'Your order CB-1001 is confirmed' },
    credentials,
    fetchImpl: graphFetch(calls) as typeof fetch,
  });
  const node = whatsappNodes.find((n) => n.type === 'whatsapp.sendMessage')!;
  const output = await node.execute(ctx, []);
  assert.equal(output.length, 1);
  assert.equal(output[0]![0]!.json['messageId'], 'wamid.NODE1');
  assert.equal(output[0]![0]!.json['status'], 'sent');
  const body = calls[0]!.body as { type: string; text: { body: string } };
  assert.equal(body.type, 'text');
  assert.equal(body.text.body, 'Your order CB-1001 is confirmed');
});

test('whatsapp.sendTemplate executes with per-item overrides', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const { ctx } = createTestNodeContext({
    parameters: { templateName: 'order_update', languageCode: 'ur_PK' },
    credentials,
    fetchImpl: graphFetch(calls) as typeof fetch,
  });
  const node = whatsappNodes.find((n) => n.type === 'whatsapp.sendTemplate')!;
  const output = await node.execute(ctx, [
    { json: { to: '923001234567' } },
    { json: { to: '923007654321' } },
  ]);
  assert.equal(output[0]!.length, 2);
  assert.equal(calls.length, 2);
  const body = calls[1]!.body as { to: string; template: { name: string; language: { code: string } } };
  assert.equal(body.to, '923007654321');
  assert.equal(body.template.name, 'order_update');
  assert.equal(body.template.language.code, 'ur_PK');
});

test('nodes fail clearly when the credential is missing', async () => {
  const { ctx } = createTestNodeContext({ parameters: { to: '1', body: 'x' } });
  const node = whatsappNodes.find((n) => n.type === 'whatsapp.sendMessage')!;
  await assert.rejects(node.execute(ctx, []), /whatsappCloud/);
});

test('whatsapp.sendMessage renders {{ }} parameters per item', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const { ctx } = createTestNodeContext({
    parameters: { to: '{{ $json.customerPhone }}', body: 'Hi {{ $json.customerName }}' },
    credentials,
    fetchImpl: graphFetch(calls) as typeof fetch,
  });
  const node = whatsappNodes.find((n) => n.type === 'whatsapp.sendMessage')!;
  const output = await node.execute(ctx, [
    { json: { customerPhone: '923001111111', customerName: 'Sara' } },
    { json: { customerPhone: '923002222222', customerName: 'Ali' } },
  ]);
  assert.equal(output[0]!.length, 2);
  assert.equal(calls.length, 2);
  assert.equal((calls[0]!.body as { to: string }).to, '923001111111');
  assert.equal((calls[1]!.body as { to: string }).to, '923002222222');
  assert.equal(
    ((calls[1]!.body as { text: { body: string } }).text.body),
    'Hi Ali',
  );
});

test('whatsapp.sendMessage ignores an httpRequest response object under `body`', async () => {
  // An httpRequest merges its response into the item as { statusCode, headers,
  // body } — that object must never override the message-body parameter
  // (it used to render as the literal string "[object Object]").
  const calls: Array<{ url: string; body: unknown }> = [];
  const { ctx } = createTestNodeContext({
    parameters: {
      to: '{{ $json.customerPhone }}',
      body: 'Payment verified. Tracking number: {{ $json.awb }}',
    },
    credentials,
    fetchImpl: graphFetch(calls) as typeof fetch,
  });
  const node = whatsappNodes.find((n) => n.type === 'whatsapp.sendMessage')!;
  await node.execute(ctx, [
    {
      json: {
        customerPhone: '923001234567',
        awb: 'EXP-1',
        statusCode: 200,
        headers: {},
        body: { extracted: { tid: 'TID1', amount: 2500 } },
      },
    },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(
    (calls[0]!.body as { text: { body: string } }).text.body,
    'Payment verified. Tracking number: EXP-1',
  );
});

test('whatsapp.downloadMedia resolves a media id to its URL', async () => {
  const calls: Array<{ url: string }> = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push({ url });
    return new Response(
      JSON.stringify({ url: 'https://lookaside.fbsbx.com/media/abc', mime_type: 'audio/ogg', file_size: 1234 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const { ctx } = createTestNodeContext({
    parameters: { mediaId: '{{ $json.mediaId }}' },
    credentials,
    fetchImpl: fetchImpl as typeof fetch,
  });
  const node = whatsappNodes.find((n) => n.type === 'whatsapp.downloadMedia')!;
  const output = await node.execute(ctx, [{ json: { mediaId: 'MEDIA-1' } }]);
  assert.equal((output[0]![0]!.json as Record<string, unknown>).mediaUrl, 'https://lookaside.fbsbx.com/media/abc');
  assert.equal((output[0]![0]!.json as Record<string, unknown>).mediaId, 'MEDIA-1');
  assert.ok(calls[0]!.url.includes('/MEDIA-1'));
});
