import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestNodeContext, NodeRegistry } from '@code-brothers/node-sdk';
import { nodes, registerInstagramNodes } from './nodes.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function graphStub() {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
    const { pathname } = new URL(url);
    if (pathname.endsWith('/media')) return jsonResponse({ id: 'cont-1' });
    if (pathname.endsWith('/cont-1')) return jsonResponse({ id: 'cont-1', status_code: 'FINISHED' });
    if (pathname.endsWith('/media_publish')) return jsonResponse({ id: 'published-1' });
    if (pathname.endsWith('/replies')) return jsonResponse({ id: 'reply-9' });
    if (pathname.endsWith('/me/messages')) return jsonResponse({ message_id: 'mid-9', recipient_id: 'user-1' });
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  return { urls, bodies, fetchImpl };
}

const credentials = { instagramGraph: { accessToken: 'tok-node', igUserId: 'ig-node' } };

test('instagram.publishPost node executes create -> status -> publish via ctx', async () => {
  const { urls, fetchImpl } = graphStub();
  const { ctx } = createTestNodeContext({
    parameters: { imageUrl: 'https://example.com/p.jpg', mediaType: 'IMAGE', caption: 'Hi' },
    credentials,
    fetchImpl,
  });
  const node = nodes.find((n) => n.type === 'instagram.publishPost');
  assert.ok(node);
  const out = await node.execute(ctx, []);
  assert.equal(out[0]![0]!.json.id, 'published-1');
  assert.equal(out[0]![0]!.json.creation_id, 'cont-1');
  assert.equal(urls.length, 3);
  assert.ok(new URL(urls[0]!).searchParams.get('access_token') === 'tok-node');
});

test('instagram.replyComment node posts the reply', async () => {
  const { bodies, fetchImpl } = graphStub();
  const { ctx } = createTestNodeContext({
    parameters: { commentId: 'c-55', message: 'Thanks!' },
    credentials,
    fetchImpl,
  });
  const node = nodes.find((n) => n.type === 'instagram.replyComment');
  assert.ok(node);
  const out = await node.execute(ctx, []);
  assert.equal(out[0]![0]!.json.id, 'reply-9');
  assert.deepEqual(bodies[0], { message: 'Thanks!' });
});

test('instagram.sendDm node sends the DM payload', async () => {
  const { bodies, urls, fetchImpl } = graphStub();
  const { ctx } = createTestNodeContext({
    parameters: { recipientId: 'user-1', message: 'Hello' },
    credentials,
    fetchImpl,
  });
  const node = nodes.find((n) => n.type === 'instagram.sendDm');
  assert.ok(node);
  const out = await node.execute(ctx, []);
  assert.equal(out[0]![0]!.json.message_id, 'mid-9');
  assert.ok(new URL(urls[0]!).pathname.endsWith('/me/messages'));
  assert.deepEqual(bodies[0], {
    recipient: { id: 'user-1' },
    messaging_type: 'RESPONSE',
    message: { text: 'Hello' },
  });
});

test('nodes fail clearly without credentials', async () => {
  const { fetchImpl } = graphStub();
  const { ctx } = createTestNodeContext({ parameters: {}, credentials: {}, fetchImpl });
  const node = nodes.find((n) => n.type === 'instagram.sendDm');
  assert.ok(node);
  await assert.rejects(() => node.execute(ctx, []), /instagramGraph/);
});

test('registerInstagramNodes registers all three nodes', () => {
  const registry = new NodeRegistry();
  registerInstagramNodes(registry);
  assert.equal(registry.size, 3);
  assert.deepEqual(registry.types().sort(), [
    'instagram.publishPost',
    'instagram.replyComment',
    'instagram.sendDm',
  ]);
});
