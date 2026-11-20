import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestNodeContext, NodeRegistry } from '@code-brothers/node-sdk';
import { nodes, registerYoutubeNodes } from './nodes.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const credentials = { youtubeOAuth: { accessToken: 'node-token' } };

test('youtube.uploadVideo node decodes base64 and runs the resumable flow', async () => {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers = (init?.headers as Record<string, string>) ?? {};
    seen.push({ url: String(input), method: init?.method ?? 'GET', headers, body: init?.body });
    if ((init?.method ?? 'GET') === 'POST') {
      assert.equal(headers.Authorization, 'Bearer node-token');
      return jsonResponse({}, 200, { Location: 'https://upload.example.test/session-node' });
    }
    // PUT of the media bytes: body should be the decoded "hello-video" bytes.
    const bytes = init?.body as Uint8Array;
    assert.equal(Buffer.from(bytes).toString('utf8'), 'hello-video');
    assert.equal(headers['Content-Range'], 'bytes 0-10/11');
    return jsonResponse({ id: 'node-video-1', snippet: { title: 'Node Upload' } }, 201);
  }) as unknown as typeof fetch;

  const { ctx } = createTestNodeContext({
    parameters: {
      title: 'Node Upload',
      description: 'from the node test',
      privacyStatus: 'unlisted',
      tags: 'alpha, beta , , gamma',
      contentBase64: Buffer.from('hello-video', 'utf8').toString('base64'),
    },
    credentials,
    fetchImpl,
  });
  const node = nodes.find((n) => n.type === 'youtube.uploadVideo');
  assert.ok(node);
  const out = await node.execute(ctx, []);
  assert.equal(out[0]![0]!.json.id, 'node-video-1');
  // Initiation metadata carried the parsed tags / privacy.
  const metadata = JSON.parse(String(seen[0]!.body)) as {
    snippet: { tags?: string[]; title: string };
    status: { privacyStatus: string };
  };
  assert.equal(metadata.snippet.title, 'Node Upload');
  assert.deepEqual(metadata.snippet.tags, ['alpha', 'beta', 'gamma']);
  assert.equal(metadata.status.privacyStatus, 'unlisted');
});

test('youtube.replyComment node posts a reply built from the credential token', async () => {
  let capturedBody = '';
  let capturedAuth = '';
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    void input;
    capturedBody = String(init?.body ?? '');
    capturedAuth = ((init?.headers as Record<string, string>) ?? {}).Authorization ?? '';
    return jsonResponse({ id: 'reply-77' });
  }) as unknown as typeof fetch;

  const { ctx } = createTestNodeContext({
    parameters: { commentId: 'parent-5', text: 'Thanks for watching!' },
    credentials,
    fetchImpl,
  });
  const node = nodes.find((n) => n.type === 'youtube.replyComment');
  assert.ok(node);
  const out = await node.execute(ctx, []);
  assert.equal(out[0]![0]!.json.id, 'reply-77');
  assert.equal(capturedAuth, 'Bearer node-token');
  assert.deepEqual(JSON.parse(capturedBody), {
    snippet: { parentId: 'parent-5', textOriginal: 'Thanks for watching!' },
  });
});

test('nodes fail clearly without credentials', async () => {
  const { ctx } = createTestNodeContext({ parameters: {}, credentials: {} });
  const node = nodes.find((n) => n.type === 'youtube.replyComment');
  assert.ok(node);
  await assert.rejects(() => node.execute(ctx, []), /youtubeOAuth/);
});

test('registerYoutubeNodes registers both nodes', () => {
  const registry = new NodeRegistry();
  registerYoutubeNodes(registry);
  assert.equal(registry.size, 2);
  assert.deepEqual(registry.types().sort(), ['youtube.replyComment', 'youtube.uploadVideo']);
});
