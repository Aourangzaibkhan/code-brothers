import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NodeRegistry, createTestNodeContext } from '@code-brothers/node-sdk';
import {
  courierBookShipmentNode,
  courierTrackNode,
  registerCourierNodes,
} from './nodes.js';

describe('courierBookShipment node (stub fetch)', () => {
  it('books via the expergo preset using courierApi credentials', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const { ctx } = createTestNodeContext({
      parameters: {
        preset: 'expergo',
        receiverName: 'Sara Ahmed',
        receiverPhone: '+971500000002',
        receiverAddress: 'Flat 9',
        receiverCity: 'Abu Dhabi',
        receiverCountry: 'AE',
        weightKg: 2,
      },
      credentials: { courierApi: { apiKey: 'node-key' } },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({ data: { awb_no: 'EXP-NODE-1', label_url: 'https://l/1' } }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const [out] = await courierBookShipmentNode.execute(ctx, [{ json: {} }]);
    assert.equal(out?.[0]?.json.awb, 'EXP-NODE-1');
    assert.equal(out?.[0]?.json.labelUrl, 'https://l/1');
    assert.equal(calls[0]?.url, 'https://api.expergo.com/v1/bookings');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers['X-API-Key'], 'node-key');
    const body = JSON.parse(calls[0]?.init.body as string) as {
      consignee: { name: string };
      shipper: { name: string };
    };
    assert.equal(body.consignee.name, 'Sara Ahmed');
    // Sender fell back to the documented defaults.
    assert.equal(body.shipper.name, 'Code Brothers Warehouse');
  });
});

describe('courierTrack node (stub fetch)', () => {
  it('returns normalized tracking for the tcs preset with bearer auth', async () => {
    const { ctx } = createTestNodeContext({
      parameters: { preset: 'tcs', awb: 'TCS-55' },
      credentials: { courierApi: { token: 'tok-1', baseUrl: 'https://sandbox.example' } },
      fetchImpl: async (url, init) => {
        assert.equal(String(url), 'https://sandbox.example/api/v1/track/TCS-55');
        const headers = (init?.headers ?? {}) as Record<string, string>;
        assert.equal(headers.Authorization, 'Bearer tok-1');
        return new Response(
          JSON.stringify({
            tracking: {
              consignmentNumber: 'TCS-55',
              status: 'In transit',
              delivered: false,
              checkpoints: [{ time: 't1', detail: 'Left origin', city: 'Lahore' }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const [out] = await courierTrackNode.execute(ctx, [{ json: {} }]);
    assert.equal(out?.[0]?.json.awb, 'TCS-55');
    assert.equal(out?.[0]?.json.status, 'In transit');
    assert.equal(out?.[0]?.json.delivered, false);
    assert.equal((out?.[0]?.json.events as unknown[]).length, 1);
  });
});

describe('registerCourierNodes', () => {
  it('registers exactly the two courier node types', () => {
    const registry = registerCourierNodes(new NodeRegistry());
    assert.deepEqual(registry.types().sort(), [
      'courier.bookShipment',
      'courier.track',
    ]);
  });
});
