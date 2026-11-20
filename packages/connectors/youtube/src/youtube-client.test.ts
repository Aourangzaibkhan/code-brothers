import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  StaticAccessTokenProvider,
  YouTubeApiError,
  YouTubeDataClient,
  type AccessTokenProvider,
} from './youtube-client.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string;
  bodyBytes: Uint8Array | undefined;
}

function makeStubFetch(handler: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    let bodyBytes: Uint8Array | undefined;
    let bodyText = '';
    if (init?.body instanceof Uint8Array) {
      bodyBytes = init.body;
      bodyText = Buffer.from(init.body).toString('latin1');
    } else if (typeof init?.body === 'string') {
      bodyText = init.body;
    }
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      bodyText,
      bodyBytes,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

test('resumable upload honours a partial 308 Range and resumes (real local HTTP server)', async (t) => {
  const totalBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const initiateCalls: Array<{ headers: IncomingMessage['headers']; body: string; url: string }> = [];
  const putRanges: string[] = [];
  const putBodies: Buffer[] = [];
  let putCount = 0;

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method === 'POST' && req.url?.startsWith('/upload/youtube/v3/videos')) {
      initiateCalls.push({ headers: req.headers, body: body.toString('utf8'), url: req.url });
      const port = (server.address() as AddressInfo).port;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        Location: `http://127.0.0.1:${port}/upload/session-abc`,
      });
      res.end('{}');
      return;
    }
    if (req.method === 'PUT' && req.url === '/upload/session-abc') {
      putCount += 1;
      putRanges.push(String(req.headers['content-range']));
      putBodies.push(body);
      if (putCount === 1) {
        // Simulate partial receipt: client sent bytes 0-9, server only
        // durably received 0-3.
        res.writeHead(308, { Range: 'bytes=0-3', 'Content-Length': '0' });
        res.end();
        return;
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'video-xyz', snippet: { title: 'Resumed!' }, status: { privacyStatus: 'private' } }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let tokenCalls = 0;
  const countingProvider: AccessTokenProvider = {
    async getAccessToken() {
      tokenCalls += 1;
      return 'server-test-token';
    },
  };
  const client = new YouTubeDataClient({ tokenProvider: countingProvider, baseUrl });
  const video = await client.uploadVideo({
    title: 'Resumed!',
    description: 'uploaded in pieces',
    tags: ['test'],
    privacyStatus: 'private',
    bytes: totalBytes,
    contentType: 'video/mp4',
  });

  assert.equal(video.id, 'video-xyz');
  assert.ok(tokenCalls >= 1, 'token provider was consulted');
  // Initiation request
  assert.equal(initiateCalls.length, 1);
  assert.match(initiateCalls[0]!.url, /uploadType=resumable/);
  assert.match(initiateCalls[0]!.url, /part=snippet,status/);
  assert.equal(initiateCalls[0]!.headers.authorization, 'Bearer server-test-token');
  assert.equal(initiateCalls[0]!.headers['x-upload-content-length'], '10');
  assert.equal(initiateCalls[0]!.headers['x-upload-content-type'], 'video/mp4');
  const metadata = JSON.parse(initiateCalls[0]!.body) as Record<string, unknown>;
  assert.deepEqual(metadata, {
    snippet: { title: 'Resumed!', description: 'uploaded in pieces', tags: ['test'] },
    status: { privacyStatus: 'private' },
  });
  // Chunk PUTs: full range first, then resume from the acknowledged offset 4.
  assert.deepEqual(putRanges, ['bytes 0-9/10', 'bytes 4-9/10']);
  assert.deepEqual([...putBodies[0]!], [...totalBytes]);
  assert.deepEqual([...putBodies[1]!], [4, 5, 6, 7, 8, 9]);
});

test('resumable upload throws when the initiation returns no Location', async () => {
  const { fetchImpl } = makeStubFetch(() => jsonResponse({}, 200));
  const client = new YouTubeDataClient({
    tokenProvider: new StaticAccessTokenProvider('tok'),
    fetch: fetchImpl,
  });
  await assert.rejects(
    () => client.uploadVideo({ title: 'x', bytes: new Uint8Array([1]) }),
    /Location/,
  );
});

test('multi-chunk upload sends sequential Content-Range headers', async () => {
  const { calls, fetchImpl } = makeStubFetch((call) => {
    if (call.method === 'POST') {
      return jsonResponse({}, 200, { Location: 'https://upload.example.test/session-1' });
    }
    // Complete only on the final chunk (offset 8 of 10).
    if (call.headers['Content-Range'] === 'bytes 8-9/10') {
      return jsonResponse({ id: 'chunked-1' }, 201);
    }
    return new Response(null, { status: 308 });
  });
  const client = new YouTubeDataClient({
    tokenProvider: new StaticAccessTokenProvider('tok'),
    fetch: fetchImpl,
    chunkSize: 4,
  });
  const video = await client.uploadVideo({ title: 'chunky', bytes: new Uint8Array(10) });
  assert.equal(video.id, 'chunked-1');
  const ranges = calls.filter((c) => c.method === 'PUT').map((c) => c.headers['Content-Range']);
  assert.deepEqual(ranges, ['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10']);
});

test('setThumbnail builds a multipart/related body containing the image bytes', async () => {
  const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0x20, 0x30]);
  const { calls, fetchImpl } = makeStubFetch(() =>
    jsonResponse({ kind: 'youtube#thumbnailSetResponse', items: [] }),
  );
  const client = new YouTubeDataClient({
    tokenProvider: new StaticAccessTokenProvider('thumb-token'),
    fetch: fetchImpl,
  });
  const result = await client.setThumbnail('vid-123', imageBytes, 'image/jpeg');
  assert.equal(result.kind, 'youtube#thumbnailSetResponse');
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  const url = new URL(call.url);
  assert.equal(url.pathname, '/upload/youtube/v3/thumbnails/set');
  assert.equal(url.searchParams.get('videoId'), 'vid-123');
  assert.equal(call.headers.Authorization, 'Bearer thumb-token');
  const contentType = call.headers['Content-Type'] ?? '';
  const boundaryMatch = /boundary="([^"]+)"/.exec(contentType);
  assert.ok(boundaryMatch, `multipart content-type carries a boundary: ${contentType}`);
  const boundary = boundaryMatch[1]!;
  assert.ok(call.bodyText.includes(`--${boundary}`), 'body opens with the boundary');
  assert.ok(call.bodyText.includes('Content-Type: application/json; charset=UTF-8'));
  assert.ok(call.bodyText.includes('Content-Type: image/jpeg'));
  assert.ok(
    Buffer.from(call.bodyBytes!).indexOf(Buffer.from(imageBytes)) >= 0,
    'raw image bytes are present verbatim in the multipart body',
  );
  assert.ok(call.bodyText.trimEnd().endsWith(`--${boundary}--`), 'body closes with the final boundary');
});

test('listMyVideos follows channels -> uploads playlist -> playlistItems', async () => {
  const { calls, fetchImpl } = makeStubFetch((call) => {
    if (call.url.includes('/youtube/v3/channels')) {
      return jsonResponse({
        items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-uploads' } } }],
      });
    }
    if (call.url.includes('/youtube/v3/playlistItems')) {
      return jsonResponse({ items: [{ id: 'pli-1' }, { id: 'pli-2' }] });
    }
    throw new Error(`unexpected ${call.url}`);
  });
  const client = new YouTubeDataClient({
    tokenProvider: new StaticAccessTokenProvider('tok-list'),
    fetch: fetchImpl,
  });
  const items = await client.listMyVideos(7);
  assert.equal(items.length, 2);
  assert.match(calls[0]!.url, /channels\?part=contentDetails&mine=true/);
  assert.equal(calls[0]!.headers.Authorization, 'Bearer tok-list');
  const second = new URL(calls[1]!.url);
  assert.equal(second.searchParams.get('playlistId'), 'UU-uploads');
  assert.equal(second.searchParams.get('maxResults'), '7');
});

test('listComments, replyToComment and hideComment request shapes', async () => {
  const { calls, fetchImpl } = makeStubFetch((call) => {
    if (call.url.includes('/commentThreads')) {
      return jsonResponse({ items: [{ id: 'thread-1' }] });
    }
    if (call.url.includes('/comments/setModerationStatus')) {
      return new Response(null, { status: 204 });
    }
    if (call.url.includes('/youtube/v3/comments')) {
      return jsonResponse({ id: 'reply-1', snippet: { parentId: 'parent-1', textOriginal: 'Nice!' } });
    }
    throw new Error(`unexpected ${call.url}`);
  });
  const client = new YouTubeDataClient({
    tokenProvider: new StaticAccessTokenProvider('tok-comments'),
    fetch: fetchImpl,
  });

  const comments = await client.listComments('vid-9');
  assert.equal(comments.length, 1);
  let url = new URL(calls[0]!.url);
  assert.equal(url.pathname, '/youtube/v3/commentThreads');
  assert.equal(url.searchParams.get('part'), 'snippet');
  assert.equal(url.searchParams.get('videoId'), 'vid-9');
  assert.equal(calls[0]!.headers.Authorization, 'Bearer tok-comments');

  const reply = await client.replyToComment('parent-1', 'Nice!');
  assert.equal(reply.id, 'reply-1');
  url = new URL(calls[1]!.url);
  assert.equal(url.pathname, '/youtube/v3/comments');
  assert.equal(url.searchParams.get('part'), 'snippet');
  assert.equal(calls[1]!.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1]!.bodyText), {
    snippet: { parentId: 'parent-1', textOriginal: 'Nice!' },
  });

  const hidden = await client.hideComment('comment-7');
  assert.deepEqual(hidden, { id: 'comment-7', moderationStatus: 'rejected' });
  url = new URL(calls[2]!.url);
  assert.equal(url.pathname, '/youtube/v3/comments/setModerationStatus');
  assert.equal(url.searchParams.get('id'), 'comment-7');
  assert.equal(url.searchParams.get('moderationStatus'), 'rejected');
  assert.equal(calls[2]!.method, 'POST');

  await client.hideComment('comment-8', 'heldForReview');
  url = new URL(calls[3]!.url);
  assert.equal(url.searchParams.get('moderationStatus'), 'heldForReview');
});

test('non-2xx responses throw YouTubeApiError with status and parsed message', async () => {
  const { fetchImpl } = makeStubFetch(() =>
    jsonResponse(
      { error: { code: 403, message: 'The request cannot be completed.', errors: [{ reason: 'forbidden' }] } },
      403,
    ),
  );
  const client = new YouTubeDataClient({
    tokenProvider: new StaticAccessTokenProvider('tok'),
    fetch: fetchImpl,
  });
  await assert.rejects(
    () => client.listComments('vid-1'),
    (err: unknown) => {
      assert.ok(err instanceof YouTubeApiError);
      assert.equal(err.status, 403);
      assert.equal(err.reason, 'forbidden');
      assert.match(err.message, /cannot be completed/);
      return true;
    },
  );
});

test('StaticAccessTokenProvider returns its token', async () => {
  assert.equal(await new StaticAccessTokenProvider('abc').getAccessToken(), 'abc');
  assert.equal(await new StaticAccessTokenProvider({ accessToken: 'def' }).getAccessToken(), 'def');
});
