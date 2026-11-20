import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { CourierApiError, CourierClient } from './client.js';
import type { BookingRequest } from './presets.js';

const BOOKING: BookingRequest = {
  sender: {
    name: 'Warehouse One',
    phone: '+971500000001',
    address: 'Street 1',
    city: 'Dubai',
    country: 'AE',
  },
  receiver: {
    name: 'Sara Ahmed',
    phone: '+971500000002',
    address: 'Flat 9, Tower B',
    city: 'Abu Dhabi',
    country: 'AE',
  },
  weightKg: 2.5,
  pieces: 2,
  codAmount: 199,
  currency: 'AED',
  description: 'Books',
};

interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe('CourierClient against a real local mock server (ExperGo preset)', () => {
  let server: Server;
  let baseUrl: string;
  const seen: SeenRequest[] = [];

  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && req.url === '/v1/bookings') {
          res.writeHead(201);
          res.end(
            JSON.stringify({
              data: { awb_no: 'EXP-9001', label_url: 'https://labels.example/EXP-9001.pdf' },
            }),
          );
          return;
        }
        if (req.method === 'GET' && req.url === '/v1/track/EXP-9001') {
          res.writeHead(200);
          res.end(
            JSON.stringify({
              data: {
                awb_no: 'EXP-9001',
                status: 'Out for delivery',
                history: [
                  { timestamp: '2026-11-19T08:00:00Z', description: 'Picked up', location: 'Dubai' },
                  { timestamp: '2026-11-20T07:30:00Z', description: 'Arrived at hub', location: 'Abu Dhabi' },
                ],
              },
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('books a shipment: server receives the mapped payload + X-API-Key', async () => {
    const client = new CourierClient({
      preset: 'expergo',
      credentials: { apiKey: 'exp-test-key' },
      baseUrl,
    });
    const result = await client.bookShipment(BOOKING);
    assert.equal(result.awb, 'EXP-9001');
    assert.equal(result.labelUrl, 'https://labels.example/EXP-9001.pdf');

    const bookingCall = seen.find((r) => r.url === '/v1/bookings');
    assert.ok(bookingCall);
    assert.equal(bookingCall.method, 'POST');
    assert.equal(bookingCall.headers['x-api-key'], 'exp-test-key');
    const payload = JSON.parse(bookingCall.body) as {
      shipper: { name: string };
      consignee: { city: string };
      parcels: Array<{ weight_kg: number; pieces: number }>;
      cod: { amount: number; currency: string };
    };
    assert.equal(payload.shipper.name, 'Warehouse One');
    assert.equal(payload.consignee.city, 'Abu Dhabi');
    assert.equal(payload.parcels[0]?.weight_kg, 2.5);
    assert.equal(payload.parcels[0]?.pieces, 2);
    assert.deepEqual(payload.cod, { amount: 199, currency: 'AED' });
  });

  it('tracks a shipment and normalizes the events', async () => {
    const client = new CourierClient({
      preset: 'expergo',
      credentials: { apiKey: 'exp-test-key' },
      baseUrl,
    });
    const tracking = await client.track('EXP-9001');
    assert.equal(tracking.awb, 'EXP-9001');
    assert.equal(tracking.status, 'Out for delivery');
    assert.equal(tracking.delivered, false);
    assert.equal(tracking.events.length, 2);
    assert.deepEqual(tracking.events[0], {
      at: '2026-11-19T08:00:00Z',
      description: 'Picked up',
      location: 'Dubai',
    });
    const trackCall = seen.find((r) => r.url === '/v1/track/EXP-9001');
    assert.equal(trackCall?.headers['x-api-key'], 'exp-test-key');
  });

  it('throws CourierApiError on non-2xx', async () => {
    const client = new CourierClient({
      preset: 'expergo',
      credentials: { apiKey: 'exp-test-key' },
      baseUrl,
    });
    await assert.rejects(
      () => client.track('MISSING'),
      (error: unknown) => {
        assert.ok(error instanceof CourierApiError);
        assert.equal(error.status, 404);
        return true;
      },
    );
  });
});

describe('CourierClient auth header logic (stub fetch)', () => {
  function capturingFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ consignmentNumber: 'TCS-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { fetchImpl, calls };
  }

  it('bearer presets send Authorization: Bearer <token>', async () => {
    const { fetchImpl, calls } = capturingFetch();
    const client = new CourierClient({
      preset: 'tcs',
      credentials: { token: 'tcs-token-123' },
      fetch: fetchImpl,
    });
    const result = await client.bookShipment(BOOKING);
    assert.equal(result.awb, 'TCS-1');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer tcs-token-123');
    assert.ok(calls[0]?.url.startsWith('https://api.tcs.com.pk/api/v1/shipments'));
  });

  it('basic auth presets send Basic base64(user:pass)', async () => {
    const { fetchImpl, calls } = capturingFetch();
    // No bundled preset uses basic auth, so drive the logic with a
    // basic-auth variant of the TCS preset shape.
    const { getPreset } = await import('./presets.js');
    const basicPreset = { ...getPreset('tcs'), auth: { type: 'basic' as const } };
    const client = new CourierClient({
      preset: basicPreset,
      credentials: { username: 'agent', password: 's3cret' },
      fetch: fetchImpl,
    });
    await client.bookShipment(BOOKING);
    const headers = calls[0]?.init.headers as Record<string, string>;
    const expected = Buffer.from('agent:s3cret', 'utf8').toString('base64');
    assert.equal(headers.Authorization, `Basic ${expected}`);
  });

  it('missing credentials for the auth scheme throw before any request', async () => {
    const client = new CourierClient({
      preset: 'expergo',
      credentials: {},
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
    });
    await assert.rejects(() => client.bookShipment(BOOKING), /apiKey/);
  });
});
