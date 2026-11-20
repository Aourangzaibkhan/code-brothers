import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphApiClient, GraphApiError } from './graph-client.js';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetch(
  handler: (call: RecordedCall, index: number) => Response | Promise<Response>,
) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: bodyText ? JSON.parse(bodyText) : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test('createMediaContainer sends the real payload shape and URL', async () => {
  const { calls, fetchImpl } = makeFetch(() => jsonResponse({ id: 'container-1' }));
  const client = new GraphApiClient({ igUserId: 'ig-123', accessToken: 'tok-abc', fetch: fetchImpl });
  const result = await client.createMediaContainer({
    imageUrl: 'https://example.com/cat.jpg',
    mediaType: 'IMAGE',
    caption: 'Hello #cats',
  });
  assert.equal(result.id, 'container-1');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin + url.pathname, 'https://graph.facebook.com/v21.0/ig-123/media');
  assert.equal(url.searchParams.get('access_token'), 'tok-abc');
  assert.equal(calls[0]!.method, 'POST');
  assert.deepEqual(calls[0]!.body, {
    image_url: 'https://example.com/cat.jpg',
    media_type: 'IMAGE',
    caption: 'Hello #cats',
  });
});

test('createMediaContainer supports REELS video containers', async () => {
  const { calls, fetchImpl } = makeFetch(() => jsonResponse({ id: 'c2' }));
  const client = new GraphApiClient({ igUserId: 'ig-1', accessToken: 't', fetch: fetchImpl });
  await client.createMediaContainer({ videoUrl: 'https://example.com/v.mp4', mediaType: 'REELS' });
  assert.deepEqual(calls[0]!.body, { video_url: 'https://example.com/v.mp4', media_type: 'REELS' });
});

test('publishMedia polls until FINISHED then publishes, in order', async () => {
  const statuses = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
  const sleeps: number[] = [];
  const { calls, fetchImpl } = makeFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname.endsWith('/media')) return jsonResponse({ id: 'cont-9' });
    if (url.pathname.endsWith('/cont-9')) {
      return jsonResponse({ id: 'cont-9', status_code: statuses.shift() ?? 'FINISHED', status: 'ok' });
    }
    if (url.pathname.endsWith('/media_publish')) return jsonResponse({ id: 'media-42' });
    throw new Error(`unexpected ${call.url}`);
  });
  const client = new GraphApiClient({
    igUserId: 'ig-1',
    accessToken: 't',
    fetch: fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    pollIntervalMs: 123,
  });
  const result = await client.publishMedia({ imageUrl: 'https://example.com/a.jpg', mediaType: 'IMAGE' });
  assert.equal(result.id, 'media-42');
  assert.equal(result.creation_id, 'cont-9');
  // Order: create, status, status, status, publish
  assert.equal(calls.length, 5);
  assert.ok(new URL(calls[0]!.url).pathname.endsWith('/media'));
  for (const i of [1, 2, 3]) {
    const u = new URL(calls[i]!.url);
    assert.ok(u.pathname.endsWith('/cont-9'));
    assert.equal(u.searchParams.get('fields'), 'status_code,status');
    assert.equal(calls[i]!.method, 'GET');
  }
  assert.ok(new URL(calls[4]!.url).pathname.endsWith('/media_publish'));
  assert.deepEqual(calls[4]!.body, { creation_id: 'cont-9' });
  assert.deepEqual(sleeps, [123, 123]);
});

test('publishMedia throws on ERROR container status', async () => {
  const { fetchImpl } = makeFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname.endsWith('/media')) return jsonResponse({ id: 'cont-x' });
    return jsonResponse({ id: 'cont-x', status_code: 'ERROR', status: 'Media failed' });
  });
  const client = new GraphApiClient({
    igUserId: 'ig-1', accessToken: 't', fetch: fetchImpl, sleep: async () => {},
  });
  await assert.rejects(
    () => client.publishMedia({ imageUrl: 'https://example.com/a.jpg' }),
    (err: unknown) => err instanceof GraphApiError && /ERROR/.test(err.message),
  );
});

test('non-2xx Graph responses throw GraphApiError with code and message', async () => {
  const { fetchImpl } = makeFetch(() =>
    jsonResponse({ error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } }, 400),
  );
  const client = new GraphApiClient({ igUserId: 'ig-1', accessToken: 'bad', fetch: fetchImpl });
  await assert.rejects(
    () => client.listMedia(),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.code, 190);
      assert.equal(err.status, 400);
      assert.match(err.message, /Invalid OAuth/);
      return true;
    },
  );
});

test('listMedia, getComments, reply, hide and DM request shapes', async () => {
  const { calls, fetchImpl } = makeFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname.endsWith('/media')) return jsonResponse({ data: [{ id: 'm1' }] });
    if (url.pathname.endsWith('/comments')) return jsonResponse({ data: [{ id: 'cm1', text: 'hi' }] });
    if (url.pathname.endsWith('/replies')) return jsonResponse({ id: 'reply-1' });
    if (url.pathname.endsWith('/me/messages')) return jsonResponse({ recipient_id: 'user-7', message_id: 'mid-1' });
    return jsonResponse({ success: true });
  });
  const client = new GraphApiClient({ igUserId: 'ig-9', accessToken: 'tok', fetch: fetchImpl });

  const media = await client.listMedia(5);
  assert.deepEqual((media as { data: unknown }).data, [{ id: 'm1' }]);
  let url = new URL(calls[0]!.url);
  assert.equal(url.pathname, '/v21.0/ig-9/media');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.match(url.searchParams.get('fields') ?? '', /media_url/);

  const comments = await client.getComments('media-1');
  assert.deepEqual((comments as { data: unknown }).data, [{ id: 'cm1', text: 'hi' }]);
  url = new URL(calls[1]!.url);
  assert.equal(url.pathname, '/v21.0/media-1/comments');

  const reply = await client.replyToComment('cm1', 'Thanks!');
  assert.equal(reply.id, 'reply-1');
  url = new URL(calls[2]!.url);
  assert.equal(url.pathname, '/v21.0/cm1/replies');
  assert.deepEqual(calls[2]!.body, { message: 'Thanks!' });

  await client.hideComment('cm1');
  url = new URL(calls[3]!.url);
  assert.equal(url.pathname, '/v21.0/cm1');
  assert.deepEqual(calls[3]!.body, { hidden: true });

  await client.hideComment('cm1', false);
  assert.deepEqual(calls[4]!.body, { hidden: false });

  const dm = await client.sendDirectMessage('user-7', 'Hello there');
  assert.equal(dm.message_id, 'mid-1');
  url = new URL(calls[5]!.url);
  assert.equal(url.pathname, '/v21.0/me/messages');
  assert.equal(url.searchParams.get('access_token'), 'tok');
  assert.deepEqual(calls[5]!.body, {
    recipient: { id: 'user-7' },
    messaging_type: 'RESPONSE',
    message: { text: 'Hello there' },
  });
});

test('getContainerStatus and publishContainer hit the right endpoints', async () => {
  const { calls, fetchImpl } = makeFetch(() => jsonResponse({ id: 'x', status_code: 'FINISHED' }));
  const client = new GraphApiClient({ igUserId: 'ig-1', accessToken: 't', fetch: fetchImpl, apiVersion: 'v20.0', baseUrl: 'https://graph.example.test/' });
  const status = await client.getContainerStatus('cont-1');
  assert.equal(status.status_code, 'FINISHED');
  assert.equal(new URL(calls[0]!.url).pathname, '/v20.0/cont-1');
  await client.publishContainer('cont-1');
  assert.deepEqual(calls[1]!.body, { creation_id: 'cont-1' });
  assert.equal(new URL(calls[1]!.url).pathname, '/v20.0/ig-1/media_publish');
});
