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
    'whatsapp.sendMessage',
    'whatsapp.sendTemplate',
  ]);
  assert.equal(whatsappNodes.length, 2);
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
