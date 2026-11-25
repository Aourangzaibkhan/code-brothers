/**
 * Mock-provider template verification.
 *
 * Runs every shipped workflow template end to end against LOCAL MOCK
 * providers — no real WhatsApp/Shopify/Daraz/Meta/Google accounts or keys
 * needed. This is the honest verification story for this repo: connectors
 * were tested against mocks; a buyer must connect their own accounts/keys
 * before any of it touches a live provider.
 *
 * What it does:
 *   1. Starts a mock provider server (WhatsApp Graph, Shopify, Daraz,
 *      Instagram Graph, YouTube Data, ExperGo/TCS couriers, WooCommerce,
 *      Google YouTube comments) on 127.0.0.1:18080 and a mock AI media
 *      worker on 127.0.0.1:8000 (the templates call ai-media-worker:8000 —
 *      add `127.0.0.1 ai-media-worker` to /etc/hosts first).
 *   2. Starts the real API (apps/api/dist/server.js) on PORT 3001 with a
 *      fresh master key and in-memory stores.
 *   3. Seeds the owner account, mock credentials (baseUrl overrides),
 *      a SKU mapping, a RAG document, and — via verify-setup-db.mjs — the
 *      local Postgres tables the templates' SQL touches.
 *   4. Imports each template, runs it with mock trigger data, and checks
 *      the execution record + the mock calls that were actually made.
 *
 * Usage:
 *   npm run build
 *   node scripts/verify-templates.mjs [--api-port 3001] [--mock-port 18080]
 *
 * Env:
 *   CB_VERIFY_PG   Postgres connection string for the local-store tables
 *                  (default postgres://codebrothers:codebrothers@127.0.0.1:5432/codebrothers)
 *   CB_MASTER_KEY  Master key for the test API (default: generated)
 *
 * Exit code 0 = every template ran end to end; otherwise the failing
 * template(s) are listed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = Number(process.argv.find((a) => a.startsWith('--api-port='))?.split('=')[1] ?? 3001);
const MOCK_PORT = Number(process.argv.find((a) => a.startsWith('--mock-port='))?.split('=')[1] ?? 18080);
const MEDIA_PORT = 8000;
const API = `http://127.0.0.1:${API_PORT}`;
const MOCK = `http://localhost:${MOCK_PORT}`;
const PG_URL =
  process.env.CB_VERIFY_PG ??
  'postgres://codebrothers:codebrothers@127.0.0.1:5432/codebrothers';

/* ------------------------------------------------------------------ */
/* Mock providers                                                      */
/* ------------------------------------------------------------------ */

const calls = [];
function record(req, body) {
  calls.push({ method: req.method, url: req.url, body });
}
function json(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(data);
      }
    });
  });
}

/** One mock server; `isMedia` switches the route table to the AI worker. */
function mockHandler(isMedia) {
  return async (req, res) => {
    const body = await readBody(req);
    record(req, body);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (isMedia) {
      if (p === '/transcribe' && req.method === 'POST') {
        return json(res, 200, {
          text: 'red shoes',
          language: 'en',
          duration: 2.5,
          segments: [{ start: 0, end: 2.5, text: 'red shoes' }],
          kind: 'ogg',
        });
      }
      if (p === '/ocr' && req.method === 'POST') {
        return json(res, 200, {
          lines: [
            { text: 'Transaction ID: TID987654', confidence: 0.98 },
            { text: 'Rs. 2,500', confidence: 0.97 },
          ],
          text: 'Transaction ID: TID987654\nRs. 2,500',
          kind: 'png',
          extracted: { tid: 'TID987654', amount: 2500 },
        });
      }
      if (p === '/video/clip' && req.method === 'POST') {
        return json(res, 200, {
          dryRun: false,
          command: ['ffmpeg', '-y'],
          outputPath: '/media/clips/long-video-clip.mp4',
          sizeBytes: 1234,
          contentBase64: Buffer.from('fake-mp4-bytes').toString('base64'),
          publicUrl: `${MOCK}/clips/long-video-clip.mp4`,
        });
      }
      if (p === '/health') return json(res, 200, { status: 'ok' });
      return json(res, 404, { error: 'mock media: unknown route ' + p });
    }

    // Instagram media-container status poll (checked before the WhatsApp
    // media route below — both are GET /v21.0/{id}).
    if (/^\/v21\.0\/17841400000000001$/.test(p) && req.method === 'GET') {
      return json(res, 200, { id: '17841400000000001', status_code: 'FINISHED', status: 'Published' });
    }
    // WhatsApp Cloud API
    if (/^\/v21\.0\/[^/]+\/messages$/.test(p) && req.method === 'POST') {
      return json(res, 200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid-mock-1' }] });
    }
    if (/^\/v21\.0\/[A-Za-z0-9_-]+$/.test(p) && req.method === 'GET') {
      return json(res, 200, {
        url: `${MOCK}/mock-media/voice.ogg`,
        mime_type: 'audio/ogg',
        sha256: 'abc',
        file_size: 1234,
      });
    }
    // Shopify Admin API
    if (p.endsWith('/draft_orders.json') && req.method === 'POST') {
      return json(res, 201, { draft_order: { id: 9001, line_items: body?.draft_order?.line_items ?? [] } });
    }
    if (p.endsWith('/inventory_levels/set.json') && req.method === 'POST') {
      return json(res, 200, { inventory_level: { available: body?.available ?? 0, inventory_item_id: body?.inventory_item_id } });
    }
    if (p.endsWith('/orders.json') && req.method === 'GET') {
      return json(res, 200, {
        orders: [
          { id: 101, total_price: '120.50', currency: 'PKR' },
          { id: 102, total_price: '30.00', currency: 'PKR' },
        ],
      });
    }
    // Daraz (baseUrl includes /rest)
    if (p === '/rest/orders/get' && req.method === 'GET') {
      return json(res, 200, {
        code: '0',
        data: { orders: [{ order_id: 201, price: 45.0 }, { order_id: 202, price: 10.0 }] },
      });
    }
    if (p === '/rest/product/item/update' && req.method === 'POST') {
      return json(res, 200, { code: '0', data: { success: true } });
    }
    // Instagram Graph API
    if (/^\/v21\.0\/[^/]+\/media$/.test(p) && req.method === 'POST') {
      return json(res, 200, { id: '17841400000000001' });
    }
    if (/^\/v21\.0\/[^/]+\/media_publish$/.test(p) && req.method === 'POST') {
      return json(res, 200, { id: '17841400000000002' });
    }
    if (/^\/v21\.0\/[^/]+\/replies$/.test(p) && req.method === 'POST') {
      return json(res, 200, { id: 'reply-mock-1' });
    }
    if (p === '/v21.0/me/messages' && req.method === 'POST') {
      return json(res, 200, { message_id: 'mid-mock-1' });
    }
    // YouTube Data API (upload + comments)
    if (p === '/upload/youtube/v3/videos' && req.method === 'POST') {
      res.writeHead(200, {
        Location: `${MOCK}/upload/youtube/v3/videos?upload_id=mock-session`,
        'content-type': 'application/json',
      });
      return res.end('{}');
    }
    if (p === '/upload/youtube/v3/videos' && req.method === 'PUT') {
      return json(res, 200, {
        id: 'yt-mock-1',
        snippet: { title: body?.snippet?.title ?? 'mock' },
        status: { privacyStatus: 'public' },
      });
    }
    if (p === '/youtube/v3/commentThreads' && req.method === 'GET') {
      return json(res, 200, {
        items: [
          {
            id: 'thread-1',
            snippet: {
              topLevelComment: {
                id: 'c1',
                snippet: { textDisplay: 'What is the price?' },
              },
            },
          },
          {
            id: 'thread-2',
            snippet: {
              topLevelComment: {
                id: 'c2',
                snippet: { textDisplay: 'Check this http://spam.example' },
              },
            },
          },
        ],
      });
    }
    if (p === '/youtube/v3/comments' && req.method === 'POST') {
      return json(res, 200, { id: 'comment-mock-1' });
    }
    if (p === '/youtube/v3/comments/setModerationStatus' && req.method === 'POST') {
      return json(res, 200, {});
    }
    // Couriers
    if (p === '/v1/bookings' && req.method === 'POST') {
      return json(res, 201, { data: { awb_no: 'EXP-MOCK-1', label_url: `${MOCK}/labels/exp1.pdf` } });
    }
    if (p === '/api/v1/shipments' && req.method === 'POST') {
      return json(res, 201, { consignmentNumber: 'TCS-MOCK-1', labelUrl: `${MOCK}/labels/tcs1.pdf` });
    }
    // WooCommerce
    if (p === '/wp-json/wc/v3/orders' && req.method === 'GET') {
      return json(res, 200, [{ id: 301, total: '55.00', status: 'completed' }]);
    }
    // Mock media file (the voice-note / screenshot URL the worker "downloads")
    if (p === '/mock-media/voice.ogg') {
      res.writeHead(200, { 'content-type': 'audio/ogg' });
      return res.end('fake-ogg');
    }
    if (p === '/clips/long-video-clip.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return res.end('fake-mp4');
    }
    return json(res, 404, { error: 'mock: unknown route ' + req.method + ' ' + p });
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // No host: dual-stack bind, so both localhost -> 127.0.0.1 and ::1 work.
    server.listen(port, () => resolve(server));
  });
}

/* ------------------------------------------------------------------ */
/* API driver                                                          */
/* ------------------------------------------------------------------ */

async function api(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForApi() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await api('GET', '/api/setup/status');
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('API did not come up on ' + API);
}

function spawnApi(masterKey) {
  const child = spawn('node', ['apps/api/dist/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      CB_MASTER_KEY: masterKey,
      CB_INTERNAL_HOSTS: 'localhost,ai-media-worker,host.docker.internal',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stdout += d.toString()));
  return { child, getOutput: () => stdout };
}

/* ------------------------------------------------------------------ */
/* Template runs                                                       */
/* ------------------------------------------------------------------ */

const MOCK_BASE = MOCK;
const templates = [
  {
    file: 'template-01-whatsapp-sales-assistant.json',
    triggerData: { messageType: 'text', text: 'red shoes', from: '923001234567', language: 'en' },
    variables: {
      mediaWorkerBaseUrl: 'http://localhost:8000',
      apiBaseUrl: `http://localhost:${API_PORT}`,
    },
    expect: {
      execution: 'success',
      calls: [
        { method: 'POST', urlContains: '/v21.0/PN123/messages', bodyContains: '923001234567' },
        { method: 'POST', urlContains: '/admin/api/2024-10/draft_orders.json' },
      ],
    },
  },
  {
    file: 'template-02-payment-screenshot-verifier.json',
    triggerData: {
      mediaId: 'MEDIA-9', customerPhone: '923001234567', customerName: 'Sara Ahmed',
      address: 'House 1, Street 2', city: 'Lahore', orderId: 'ORD-100',
    },
    variables: { mediaWorkerBaseUrl: 'http://localhost:8000' },
    expect: {
      execution: 'success',
      calls: [
        { method: 'POST', urlContains: '/v21.0/PN123/messages', bodyContains: 'Payment verified' },
        { method: 'POST', urlContains: '/v1/bookings', bodyContains: 'Sara Ahmed' },
      ],
    },
  },
  {
    file: 'template-03-stock-sync-3-channel.json',
    triggerData: {
      lineItems: [
        { sellerSku: 'SKU-RED', remainingStock: 4, inventoryItemId: 201, quantity: 2, masterSku: 'SHOE-RED' },
        { sellerSku: 'SKU-BLU', remainingStock: 9, inventoryItemId: 202, quantity: 1, masterSku: 'SHOE-BLU' },
      ],
    },
    variables: { shopifyLocationId: 101 },
    expect: {
      execution: 'success',
      calls: [
        { method: 'POST', urlContains: '/rest/product/item/update' },
        { method: 'POST', urlContains: '/admin/api/2024-10/inventory_levels/set.json' },
      ],
    },
  },
  {
    file: 'template-04-cod-fake-order-shield.json',
    triggerData: {
      customerPhone: '923009999999', customerName: 'Ali Raza', address: 'House 5',
      city: 'Karachi', orderId: 'COD-55', total: 2500, customerLanguage: 'en_US',
    },
    variables: {},
    expect: {
      execution: 'success',
      calls: [
        { method: 'POST', urlContains: '/v21.0/PN123/messages', bodyContains: 'COD-55' },
        { method: 'POST', urlContains: '/api/v1/shipments' },
      ],
    },
  },
  {
    file: 'template-05-instagram-comment-to-sale.json',
    triggerData: { text: 'What is the price?', commentId: 'c100', userId: 'u100' },
    variables: { productLink: 'https://shop.example/p/red-shoes' },
    expect: {
      execution: 'success',
      calls: [
        { method: 'POST', urlContains: '/v21.0/c100/replies' },
        { method: 'POST', urlContains: '/v21.0/me/messages', bodyContains: 'product link' },
      ],
    },
  },
  {
    file: 'template-06-reels-shorts-factory.json',
    triggerData: { sourcePath: 'long-video.mp4', language: 'en' },
    variables: { mediaWorkerBaseUrl: 'http://localhost:8000' },
    expect: {
      execution: 'success',
      calls: [
        { method: 'POST', urlContains: '/upload/youtube/v3/videos' },
        { method: 'POST', urlContains: '/v21.0/IG123/media' },
      ],
    },
  },
  {
    file: 'template-07-youtube-upload-auto-promoter.json',
    triggerData: {
      aiPromoText: 'New drop: Red Shoes are here!',
      videoUrl: 'https://youtu.be/yt-mock-1',
      thumbnailUrl: `${MOCK}/thumb.jpg`,
    },
    variables: { broadcastPhone: '923001234567' },
    expect: {
      execution: 'success',
      calls: [
        { method: 'POST', urlContains: '/v21.0/PN123/messages', bodyContains: 'Red Shoes' },
        { method: 'POST', urlContains: '/v21.0/IG123/media' },
      ],
    },
  },
  {
    file: 'template-08-comment-growth-spam-shield.json',
    triggerData: {},
    variables: {
      monitoredVideoId: 'vid-1',
      productLink: 'https://shop.example/p/red-shoes',
      youtubeApiBaseUrl: MOCK,
    },
    expect: {
      execution: 'success',
      calls: [
        { method: 'POST', urlContains: '/youtube/v3/comments/setModerationStatus' },
        { method: 'POST', urlContains: '/youtube/v3/comments?part=snippet' },
      ],
    },
  },
  {
    file: 'template-09-abandoned-cart-recovery.json',
    triggerData: {
      paid: false, customerPhone: '923001234567', customerName: 'Sara',
      checkoutUrl: 'https://shop.example/checkout/abc', checkoutId: 'chk-1',
    },
    variables: {},
    // The 2h wait would stall the run; the template is verified with the
    // wait node replaced by a 0s wait in-memory for this run (see below).
    expect: {
      execution: 'success',
      calls: [{ method: 'POST', urlContains: '/v21.0/PN123/messages', bodyContains: 'cart is still waiting' }],
    },
  },
  {
    file: 'template-10-ceo-digest.json',
    triggerData: {},
    variables: { ownerPhone: '923001234567' },
    expect: {
      execution: 'success',
      calls: [
        { method: 'GET', urlContains: '/admin/api/2024-10/orders.json' },
        { method: 'GET', urlContains: '/rest/orders/get' },
        { method: 'GET', urlContains: '/wp-json/wc/v3/orders' },
        { method: 'POST', urlContains: '/v21.0/PN123/messages', bodyContains: 'Daily Digest' },
      ],
    },
  },
];

function callMatches(call, want) {
  if (call.method !== want.method) return false;
  if (want.urlContains && !call.url.includes(want.urlContains)) return false;
  if (want.bodyContains) {
    const text = typeof call.body === 'string' ? call.body : JSON.stringify(call.body ?? '');
    if (!text.includes(want.bodyContains)) return false;
  }
  return true;
}

async function main() {
  const mockServer = await listen(createServer(mockHandler(false)), MOCK_PORT);
  const mediaServer = await listen(createServer(mockHandler(true)), MEDIA_PORT);
  console.log(`mock providers on ${MOCK}, mock media worker on 127.0.0.1:${MEDIA_PORT}`);

  const masterKey = process.env.CB_MASTER_KEY ?? randomBytes(32).toString('hex');
  const { child: apiChild, getOutput } = spawnApi(masterKey);
  let failures = [];
  try {
    await waitForApi();
    const out = getOutput();
    const tokenMatch = out.match(/setup token:\s*([A-Za-z0-9_-]+)/i);
    if (!tokenMatch) throw new Error('setup token not found in API output:\n' + out.slice(-2000));
    const setupToken = tokenMatch[1];
    const testPassword = randomBytes(16).toString('hex');

    const claim = await api('POST', '/api/setup/claim', undefined, {
      setupToken,
      email: 'owner@example.com',
      password: testPassword,
      displayName: 'Owner',
    });
    if (claim.status !== 201 && claim.status !== 200) {
      throw new Error('setup claim failed: ' + JSON.stringify(claim));
    }
    const userId = claim.body.user?.id;
    const token = claim.body.token;
    if (!userId || !token) throw new Error('claim returned no user/token: ' + JSON.stringify(claim.body));

    // Local Postgres tables + seed rows for the templates' SQL.
    const { spawnSync } = await import('node:child_process');
    const db = spawnSync(
      'node',
      ['scripts/verify-setup-db.mjs', PG_URL, userId],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (db.status !== 0) {
      throw new Error('verify-setup-db failed:\n' + (db.stdout ?? '') + (db.stderr ?? ''));
    }
    console.log((db.stdout ?? '').trim());

    // Mock credentials (baseUrl overrides point every provider at the mock).
    const creds = [
      { name: 'whatsappCloud', data: { phoneNumberId: 'PN123', accessToken: 'EAATOKEN', baseUrl: MOCK } },
      { name: 'shopifyApi', data: { shop: 'mock-shop', accessToken: 'shpat-mock', baseUrl: `${MOCK}/admin/api/2024-10` } },
      { name: 'darazApi', data: { appKey: '123456', appSecret: 'secret', accessToken: 'tok', country: 'pk', baseUrl: `${MOCK}/rest` } },
      { name: 'instagramGraph', data: { accessToken: 'IGTOKEN', igUserId: 'IG123', baseUrl: MOCK } },
      { name: 'youtubeOAuth', data: { accessToken: 'YTOKEN', baseUrl: MOCK } },
      { name: 'courierApi', data: { apiKey: 'node-key', token: 'tcs-token', baseUrl: MOCK } },
      { name: 'localStore', data: { connectionString: PG_URL, webhookSecret: 'whsec-mock', storeUrl: MOCK, consumerKey: 'ck-mock', consumerSecret: 'cs-mock' } },
    ];
    for (const c of creds) {
      const r = await api('POST', '/api/credentials', token, { name: c.name, value: c.data });
      if (r.status !== 201 && r.status !== 200) {
        throw new Error(`credential ${c.name} failed: ` + JSON.stringify(r));
      }
    }

    // SKU mapping so the RAG catalog answers template-01, plus a doc.
    const sku = await api('POST', '/api/catalog/sku-mappings', token, {
      masterSku: 'red shoes',
      shopifySku: 'SHOE-RED',
      prices: { shopify: 2500, local: 2500 },
      stock: { shopify: 10, local: 10 },
    });
    if (sku.status !== 201 && sku.status !== 200) {
      console.log('note: sku mapping seed returned', sku.status, JSON.stringify(sku.body).slice(0, 200));
    }
    const ragDoc = await api('POST', '/api/rag/documents', token, {
      title: 'Red Shoes',
      content: 'Red Shoes are our best-selling running shoes. Price 2500, 10 in stock.',
      metadata: { price: 2500, stock: 10, sku: 'red shoes' },
    });
    if (ragDoc.status !== 201 && ragDoc.status !== 200) {
      console.log('note: rag doc seed returned', ragDoc.status, JSON.stringify(ragDoc.body).slice(0, 200));
    }

    // Import + run each template.
    for (const t of templates) {
      const def = JSON.parse(readFileSync(join(ROOT, 'templates', t.file), 'utf8'));
      // Template-09's 2h wait would stall the run; shrink it for the mock run.
      if (t.file.startsWith('template-09')) {
        for (const n of def.nodes) if (n.id === 'wait') n.parameters.seconds = 0;
      }
      const created = await api('POST', '/api/workflows', token, {
        name: def.name,
        description: def.description ?? '',
        nodes: def.nodes,
        edges: def.edges,
        settings: def.settings ?? {},
      });
      if (created.status !== 201 && created.status !== 200) {
        failures.push(`${t.file}: import failed (${created.status}) ${JSON.stringify(created.body).slice(0, 300)}`);
        console.log(`FAIL ${t.file}: import failed`);
        continue;
      }
      const workflowId = created.body.id;
      const before = calls.length;
      const run = await api('POST', `/api/workflows/${workflowId}/run`, token, {
        triggerData: t.triggerData,
        variables: t.variables,
      });
      if (run.status !== 200 && run.status !== 201) {
        failures.push(`${t.file}: run request failed (${run.status}) ${JSON.stringify(run.body).slice(0, 300)}`);
        console.log(`FAIL ${t.file}: run request failed`);
        continue;
      }
      // The run endpoint returns the execution record directly.
      const execution = run.body;
      const newCalls = calls.slice(before);
      if (process.env.CB_VERIFY_DEBUG) {
        console.log(`  [debug ${t.file}] execution status=${execution?.status}`);
        for (const s of execution?.steps ?? []) {
          console.log(`    step ${s.nodeName} (${s.nodeType}): ${s.status}${s.error ? ` — ${s.error}` : ''}`);
        }
        for (const c of newCalls) {
          console.log(`    call ${c.method} ${c.url} :: ${JSON.stringify(c.body)?.slice(0, 220)}`);
        }
      }
      const problems = [];
      if (execution?.status !== t.expect.execution) {
        problems.push(
          `execution status ${execution?.status ?? '?'} (error: ${execution?.error ?? run.body.error ?? 'n/a'})`,
        );
      }
      for (const want of t.expect.calls) {
        if (!newCalls.some((c) => callMatches(c, want))) {
          problems.push(`missing mock call ${want.method} ${want.urlContains ?? ''}${want.bodyContains ? ` containing ${JSON.stringify(want.bodyContains)}` : ''}`);
        }
      }
      if (problems.length > 0) {
        failures.push(`${t.file}: ${problems.join('; ')}`);
        console.log(`FAIL ${t.file}: ${problems.join('; ')}`);
        if (execution?.steps) {
          for (const s of execution.steps) {
            if (s.status === 'error') console.log(`     step ${s.nodeName} (${s.nodeType}): ${s.error}`);
          }
        }
      } else {
        console.log(`PASS ${t.file}`);
      }
    }
  } finally {
    apiChild.kill('SIGTERM');
    mockServer.close();
    mediaServer.close();
  }

  console.log('');
  if (failures.length === 0) {
    console.log(`ALL ${templates.length} TEMPLATES PASSED end to end against mocks.`);
  } else {
    console.log(`${failures.length} template(s) FAILED:`);
    for (const f of failures) console.log(' - ' + f);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
