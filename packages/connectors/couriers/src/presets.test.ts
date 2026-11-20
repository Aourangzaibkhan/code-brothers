import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COURIER_PRESETS,
  dhlPreset,
  fedexPreset,
  getPreset,
  leopardsPreset,
  tcsPreset,
  type BookingRequest,
} from './presets.js';

const REQ: BookingRequest = {
  sender: { name: 'Ali', phone: '0300-1', address: 'House 1', city: 'Lahore', country: 'PK' },
  receiver: { name: 'Bilal', phone: '0321-2', address: 'House 2', city: 'Karachi', country: 'PK' },
  weightKg: 1.5,
  pieces: 3,
  codAmount: 2500,
  currency: 'PKR',
  description: 'Shoes',
  serviceType: 'overnight',
};

describe('preset catalogue', () => {
  it('ships exactly the 5 documented presets with distinct shapes', () => {
    assert.deepEqual(
      COURIER_PRESETS.map((p) => p.id),
      ['expergo', 'tcs', 'leopards', 'dhl', 'fedex'],
    );
    assert.equal(getPreset('dhl').name, 'DHL');
    assert.throws(() => getPreset('ups'), /Unknown courier preset/);
    const baseUrls = new Set(COURIER_PRESETS.map((p) => p.baseUrl));
    assert.equal(baseUrls.size, 5);
  });
});

describe('TCS preset (pure functions)', () => {
  it('mapBooking builds the flat consignment shape', () => {
    const payload = tcsPreset.mapBooking(REQ) as {
      consignment: Record<string, unknown>;
    };
    assert.equal(payload.consignment.shipperName, 'Ali');
    assert.equal(payload.consignment.consigneeCity, 'Karachi');
    assert.equal(payload.consignment.weight, 1.5);
    assert.equal(payload.consignment.pieces, 3);
    assert.equal(payload.consignment.codAmount, 2500);
    assert.equal(payload.consignment.productDetails, 'Shoes');
    assert.equal(payload.consignment.service, 'overnight');
  });

  it('parseBookingResponse + parseTracking match the declared shapes', () => {
    assert.deepEqual(
      tcsPreset.parseBookingResponse({ consignmentNumber: 'TCS-77', labelUrl: 'https://l/x' }),
      { awb: 'TCS-77', labelUrl: 'https://l/x' },
    );
    const tracking = tcsPreset.parseTracking({
      tracking: {
        consignmentNumber: 'TCS-77',
        status: 'Delivered',
        delivered: true,
        checkpoints: [
          { time: '2026-11-20T10:00:00Z', detail: 'Delivered to receiver', city: 'Karachi' },
        ],
      },
    });
    assert.equal(tracking.awb, 'TCS-77');
    assert.equal(tracking.delivered, true);
    assert.deepEqual(tracking.events, [
      { at: '2026-11-20T10:00:00Z', description: 'Delivered to receiver', location: 'Karachi' },
    ]);
    assert.deepEqual(tcsPreset.buildTrackingRequest('TCS-77'), {
      path: '/api/v1/track/TCS-77',
    });
  });
});

describe('DHL preset (pure functions)', () => {
  it('mapBooking builds the customerDetails/content shape', () => {
    const payload = dhlPreset.mapBooking(REQ) as {
      productCode: string;
      customerDetails: { receiverDetails: { fullName: string; countryCode: string } };
      content: { packages: Array<{ weight: number }>; cashOnDelivery: { amount: number } };
    };
    assert.equal(payload.productCode, 'overnight');
    assert.equal(payload.customerDetails.receiverDetails.fullName, 'Bilal');
    assert.equal(payload.customerDetails.receiverDetails.countryCode, 'PK');
    assert.equal(payload.content.packages[0]?.weight, 1.5);
    assert.equal(payload.content.cashOnDelivery.amount, 2500);
  });

  it('tracking goes through the query string and parses nested events', () => {
    assert.deepEqual(dhlPreset.buildTrackingRequest('DHL-5'), {
      path: '/track/shipments',
      query: { trackingNumber: 'DHL-5' },
    });
    assert.deepEqual(
      dhlPreset.parseBookingResponse({
        shipmentTrackingNumber: 'DHL-5',
        documents: [{ url: 'https://label/dhl5' }, { url: 'https://other' }],
      }),
      { awb: 'DHL-5', labelUrl: 'https://label/dhl5' },
    );
    const tracking = dhlPreset.parseTracking({
      shipments: [
        {
          id: 'DHL-5',
          status: { statusCode: 'delivered', description: 'Delivered' },
          events: [
            {
              timestamp: '2026-11-20T09:00:00Z',
              description: 'Delivered',
              location: { address: { addressLocality: 'Karachi' } },
            },
          ],
        },
      ],
    });
    assert.equal(tracking.awb, 'DHL-5');
    assert.equal(tracking.status, 'Delivered');
    assert.equal(tracking.delivered, true);
    assert.deepEqual(tracking.events, [
      { at: '2026-11-20T09:00:00Z', description: 'Delivered', location: 'Karachi' },
    ]);
  });
});

describe('Leopards + FedEx presets (pure functions)', () => {
  it('leopards converts weight to grams and parses track_number', () => {
    const payload = leopardsPreset.mapBooking(REQ) as {
      booked_packet: { packet_weight: number; packet_no_piece: number };
    };
    assert.equal(payload.booked_packet.packet_weight, 1500);
    assert.equal(payload.booked_packet.packet_no_piece, 3);
    assert.deepEqual(
      leopardsPreset.parseBookingResponse({ track_number: 'LP-9', label: 'https://l/lp9' }),
      { awb: 'LP-9', labelUrl: 'https://l/lp9' },
    );
  });

  it('fedex builds requestedShipment and digs the tracking number out of output', () => {
    const payload = fedexPreset.mapBooking(REQ) as {
      requestedShipment: {
        serviceType: string;
        packageLineItems: Array<{ weight: { units: string; value: number } }>;
      };
    };
    assert.equal(payload.requestedShipment.serviceType, 'overnight');
    assert.deepEqual(payload.requestedShipment.packageLineItems[0]?.weight, {
      units: 'KG',
      value: 1.5,
    });
    assert.deepEqual(
      fedexPreset.parseBookingResponse({
        output: {
          transactionShipments: [
            {
              masterTrackingNumber: 'FX-42',
              pieceResponses: [{ packageDocuments: [{ url: 'https://l/fx42' }] }],
            },
          ],
        },
      }),
      { awb: 'FX-42', labelUrl: 'https://l/fx42' },
    );
    const tracking = fedexPreset.parseTracking({
      output: {
        completeTrackResults: [
          {
            trackResults: [
              {
                trackingNumberInfo: { trackingNumber: 'FX-42' },
                latestStatusDetail: { code: 'DL', description: 'Delivered' },
                scanEventList: [
                  { date: '2026-11-20T08:00:00Z', eventDescription: 'Delivered', scanLocation: 'Karachi' },
                ],
              },
            ],
          },
        ],
      },
    });
    assert.equal(tracking.delivered, true);
    assert.equal(tracking.events.length, 1);
  });
});
