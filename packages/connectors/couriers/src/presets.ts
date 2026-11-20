/**
 * Courier presets: declarative descriptions of each courier's HTTP API plus
 * the pure mapping/parsing functions that translate between the shared
 * {@link BookingRequest} / {@link NormalizedTracking} shapes and each
 * courier's own wire format.
 */

export interface Party {
  name: string;
  phone: string;
  address: string;
  city: string;
  country: string;
}

export interface BookingRequest {
  sender: Party;
  receiver: Party;
  weightKg: number;
  pieces?: number;
  codAmount?: number;
  currency?: string;
  description?: string;
  serviceType?: string;
}

export interface NormalizedTrackingEvent {
  at?: string;
  description: string;
  location?: string;
}

export interface NormalizedTracking {
  awb: string;
  status: string;
  delivered: boolean;
  events: NormalizedTrackingEvent[];
}

export interface BookingResult {
  awb: string;
  labelUrl?: string;
}

export interface TrackingRequest {
  path: string;
  query?: Record<string, string>;
}

export interface CourierPreset {
  id: string;
  name: string;
  region: string;
  baseUrl: string;
  auth: {
    type: 'apiKeyHeader' | 'bearer' | 'basic';
    /** Header name for `apiKeyHeader` auth. */
    headerName?: string;
  };
  booking: { path: string; method: string };
  /** `path` may contain `{awb}`. */
  tracking: { path: string; method: string };
  mapBooking(req: BookingRequest): unknown;
  parseBookingResponse(json: unknown): BookingResult;
  buildTrackingRequest(awb: string): TrackingRequest;
  parseTracking(json: unknown): NormalizedTracking;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function partyFields(party: Party): Record<string, string> {
  return {
    name: party.name,
    phone: party.phone,
    address: party.address,
    city: party.city,
    country: party.country,
  };
}

/* ------------------------------------------------------------------ */
/* ExperGo (UAE) — api.expergo.com                                     */
/* Booking:  POST /v1/bookings  { shipper, consignee, parcels, cod }   */
/* Response: { data: { awb_no, label_url } }                           */
/* Tracking: GET  /v1/track/{awb}                                      */
/* Response: { data: { status, history: [{timestamp, description,      */
/*             location}] } }                                          */
/* ------------------------------------------------------------------ */
export const expergoPreset: CourierPreset = {
  id: 'expergo',
  name: 'ExperGo',
  region: 'UAE',
  baseUrl: 'https://api.expergo.com',
  auth: { type: 'apiKeyHeader', headerName: 'X-API-Key' },
  booking: { path: '/v1/bookings', method: 'POST' },
  tracking: { path: '/v1/track/{awb}', method: 'GET' },
  mapBooking(req) {
    return {
      shipper: partyFields(req.sender),
      consignee: partyFields(req.receiver),
      parcels: [
        {
          weight_kg: req.weightKg,
          pieces: req.pieces ?? 1,
          description: req.description ?? 'General goods',
        },
      ],
      service_type: req.serviceType ?? 'standard',
      ...(req.codAmount !== undefined
        ? { cod: { amount: req.codAmount, currency: req.currency ?? 'AED' } }
        : {}),
    };
  },
  parseBookingResponse(json) {
    const data = asRecord(asRecord(json).data);
    const awb = asString(data.awb_no);
    if (!awb) throw new Error('ExperGo booking response missing data.awb_no');
    return { awb, labelUrl: asString(data.label_url) };
  },
  buildTrackingRequest(awb) {
    return { path: `/v1/track/${encodeURIComponent(awb)}` };
  },
  parseTracking(json) {
    const root = asRecord(json);
    const data = asRecord(root.data);
    const status = asString(data.status) ?? 'unknown';
    const events = asArray(data.history).map((entry) => {
      const e = asRecord(entry);
      return {
        at: asString(e.timestamp) ?? asString(e.at),
        description: asString(e.description) ?? asString(e.status) ?? '',
        location: asString(e.location),
      };
    });
    return {
      awb: asString(data.awb_no) ?? asString(root.awb) ?? '',
      status,
      delivered: status.toLowerCase() === 'delivered',
      events,
    };
  },
};

/* ------------------------------------------------------------------ */
/* TCS (Pakistan) — api.tcs.com.pk                                     */
/* Booking:  POST /api/v1/shipments  { consignment: {...flat fields} } */
/* Response: { consignmentNumber, labelUrl }                           */
/* Tracking: GET  /api/v1/track/{awb}                                  */
/* Response: { tracking: { status, delivered,                          */
/*             checkpoints: [{time, detail, city}] } }                 */
/* ------------------------------------------------------------------ */
export const tcsPreset: CourierPreset = {
  id: 'tcs',
  name: 'TCS',
  region: 'Pakistan',
  baseUrl: 'https://api.tcs.com.pk',
  auth: { type: 'bearer' },
  booking: { path: '/api/v1/shipments', method: 'POST' },
  tracking: { path: '/api/v1/track/{awb}', method: 'GET' },
  mapBooking(req) {
    return {
      consignment: {
        shipperName: req.sender.name,
        shipperPhone: req.sender.phone,
        shipperAddress: req.sender.address,
        shipperCity: req.sender.city,
        shipperCountry: req.sender.country,
        consigneeName: req.receiver.name,
        consigneePhone: req.receiver.phone,
        consigneeAddress: req.receiver.address,
        consigneeCity: req.receiver.city,
        consigneeCountry: req.receiver.country,
        weight: req.weightKg,
        pieces: req.pieces ?? 1,
        codAmount: req.codAmount ?? 0,
        currency: req.currency ?? 'PKR',
        productDetails: req.description ?? 'General goods',
        service: req.serviceType ?? 'overnight',
      },
    };
  },
  parseBookingResponse(json) {
    const root = asRecord(json);
    const awb = asString(root.consignmentNumber);
    if (!awb) throw new Error('TCS booking response missing consignmentNumber');
    return { awb, labelUrl: asString(root.labelUrl) };
  },
  buildTrackingRequest(awb) {
    return { path: `/api/v1/track/${encodeURIComponent(awb)}` };
  },
  parseTracking(json) {
    const tracking = asRecord(asRecord(json).tracking);
    const status = asString(tracking.status) ?? 'unknown';
    const events = asArray(tracking.checkpoints).map((entry) => {
      const e = asRecord(entry);
      return {
        at: asString(e.time),
        description: asString(e.detail) ?? '',
        location: asString(e.city),
      };
    });
    return {
      awb: asString(tracking.consignmentNumber) ?? '',
      status,
      delivered: tracking.delivered === true || status.toLowerCase() === 'delivered',
      events,
    };
  },
};

/* ------------------------------------------------------------------ */
/* Leopards (Pakistan) — api.leopards.com.pk                           */
/* Booking:  POST /api/bookings  { booked_packet: {...} }              */
/*           (packet weight is in GRAMS)                               */
/* Response: { track_number, label }                                   */
/* Tracking: GET  /api/track/{awb}                                     */
/* Response: { tracking: { status, delivered, activities:              */
/*             [{date_time, status_message, location}] } }             */
/* ------------------------------------------------------------------ */
export const leopardsPreset: CourierPreset = {
  id: 'leopards',
  name: 'Leopards Courier',
  region: 'Pakistan',
  baseUrl: 'https://api.leopards.com.pk',
  auth: { type: 'apiKeyHeader', headerName: 'X-Leopards-Key' },
  booking: { path: '/api/bookings', method: 'POST' },
  tracking: { path: '/api/track/{awb}', method: 'GET' },
  mapBooking(req) {
    return {
      booked_packet: {
        sender_name: req.sender.name,
        sender_phone: req.sender.phone,
        sender_address: req.sender.address,
        sender_city: req.sender.city,
        receiver_name: req.receiver.name,
        receiver_phone: req.receiver.phone,
        receiver_address: req.receiver.address,
        receiver_city: req.receiver.city,
        packet_weight: Math.round(req.weightKg * 1000),
        packet_no_piece: req.pieces ?? 1,
        packet_collect_amount: req.codAmount ?? 0,
        packet_currency: req.currency ?? 'PKR',
        packet_description: req.description ?? 'General goods',
        service_type: req.serviceType ?? 'overnight',
      },
    };
  },
  parseBookingResponse(json) {
    const root = asRecord(json);
    const awb = asString(root.track_number);
    if (!awb) throw new Error('Leopards booking response missing track_number');
    return { awb, labelUrl: asString(root.label) };
  },
  buildTrackingRequest(awb) {
    return { path: `/api/track/${encodeURIComponent(awb)}` };
  },
  parseTracking(json) {
    const tracking = asRecord(asRecord(json).tracking);
    const status = asString(tracking.status) ?? 'unknown';
    const events = asArray(tracking.activities).map((entry) => {
      const e = asRecord(entry);
      return {
        at: asString(e.date_time),
        description: asString(e.status_message) ?? '',
        location: asString(e.location),
      };
    });
    return {
      awb: asString(tracking.track_number) ?? '',
      status,
      delivered: tracking.delivered === true || status.toLowerCase() === 'delivered',
      events,
    };
  },
};

/* ------------------------------------------------------------------ */
/* DHL (Global) — api.dhl.com                                          */
/* Booking:  POST /shipping/shipments                                  */
/* Response: { shipmentTrackingNumber, documents: [{url}] }            */
/* Tracking: GET  /track/shipments?trackingNumber={awb}                */
/* Response: { shipments: [{ id, status: {statusCode, description},    */
/*             events: [{timestamp, description,                        */
/*             location: {address: {addressLocality}}}] }] }           */
/* ------------------------------------------------------------------ */
export const dhlPreset: CourierPreset = {
  id: 'dhl',
  name: 'DHL',
  region: 'Global',
  baseUrl: 'https://api.dhl.com',
  auth: { type: 'apiKeyHeader', headerName: 'DHL-API-Key' },
  booking: { path: '/shipping/shipments', method: 'POST' },
  tracking: { path: '/track/shipments', method: 'GET' },
  mapBooking(req) {
    return {
      productCode: req.serviceType ?? 'P',
      customerDetails: {
        shipperDetails: {
          fullName: req.sender.name,
          phone: req.sender.phone,
          address: req.sender.address,
          city: req.sender.city,
          countryCode: req.sender.country,
        },
        receiverDetails: {
          fullName: req.receiver.name,
          phone: req.receiver.phone,
          address: req.receiver.address,
          city: req.receiver.city,
          countryCode: req.receiver.country,
        },
      },
      content: {
        packages: [{ weight: req.weightKg, pieces: req.pieces ?? 1 }],
        isCustomsDeclarable: false,
        descriptionOfContent: req.description ?? 'General goods',
        ...(req.codAmount !== undefined
          ? {
              cashOnDelivery: {
                amount: req.codAmount,
                currency: req.currency ?? 'USD',
              },
            }
          : {}),
      },
    };
  },
  parseBookingResponse(json) {
    const root = asRecord(json);
    const awb = asString(root.shipmentTrackingNumber);
    if (!awb) throw new Error('DHL booking response missing shipmentTrackingNumber');
    const documents = asArray(root.documents);
    const labelUrl =
      documents.length > 0 ? asString(asRecord(documents[0]).url) : undefined;
    return { awb, labelUrl };
  },
  buildTrackingRequest(awb) {
    return { path: '/track/shipments', query: { trackingNumber: awb } };
  },
  parseTracking(json) {
    const shipments = asArray(asRecord(json).shipments);
    const shipment = asRecord(shipments[0]);
    const statusObj = asRecord(shipment.status);
    const status =
      asString(statusObj.description) ?? asString(statusObj.statusCode) ?? 'unknown';
    const statusCode = asString(statusObj.statusCode);
    const events = asArray(shipment.events).map((entry) => {
      const e = asRecord(entry);
      const location = asRecord(e.location);
      const address = asRecord(location.address);
      return {
        at: asString(e.timestamp),
        description: asString(e.description) ?? '',
        location: asString(address.addressLocality) ?? asString(location.addressLocality),
      };
    });
    return {
      awb: asString(shipment.id) ?? '',
      status,
      delivered:
        statusCode === 'delivered' || status.toLowerCase() === 'delivered',
      events,
    };
  },
};

/* ------------------------------------------------------------------ */
/* FedEx (Global) — apis.fedex.com                                     */
/* Booking:  POST /ship/v1/shipments  { requestedShipment: {...} }     */
/* Response: { output: { transactionShipments:                         */
/*             [{ masterTrackingNumber,                                */
/*                pieceResponses: [{ packageDocuments: [{url}] }] }]}} */
/* Tracking: GET  /track/v1/tracking/{awb}                             */
/* Response: { output: { completeTrackResults: [{ trackResults:        */
/*             [{ trackingNumberInfo: {trackingNumber},                 */
/*                latestStatusDetail: {code, description},              */
/*                scanEventList: [{date, eventDescription,              */
/*                scanLocation}] }] }] } }                              */
/* ------------------------------------------------------------------ */
export const fedexPreset: CourierPreset = {
  id: 'fedex',
  name: 'FedEx',
  region: 'Global',
  baseUrl: 'https://apis.fedex.com',
  auth: { type: 'bearer' },
  booking: { path: '/ship/v1/shipments', method: 'POST' },
  tracking: { path: '/track/v1/tracking/{awb}', method: 'GET' },
  mapBooking(req) {
    return {
      labelResponseOptions: 'URL_ONLY',
      requestedShipment: {
        shipper: {
          contact: { personName: req.sender.name, phoneNumber: req.sender.phone },
          address: {
            streetLines: [req.sender.address],
            city: req.sender.city,
            countryCode: req.sender.country,
          },
        },
        recipients: [
          {
            contact: { personName: req.receiver.name, phoneNumber: req.receiver.phone },
            address: {
              streetLines: [req.receiver.address],
              city: req.receiver.city,
              countryCode: req.receiver.country,
            },
          },
        ],
        pickupType: 'USE_SCHEDULED_PICKUP',
        serviceType: req.serviceType ?? 'FEDEX_GROUND',
        packagingType: 'YOUR_PACKAGING',
        totalWeight: req.weightKg,
        packageLineItems: [
          {
            sequenceNumber: 1,
            weight: { units: 'KG', value: req.weightKg },
            itemDescription: req.description ?? 'General goods',
          },
        ],
        ...(req.codAmount !== undefined
          ? {
              shipmentSpecialServices: {
                specialServiceTypes: ['COD'],
                codDetail: {
                  codCollectionAmount: {
                    amount: req.codAmount,
                    currency: req.currency ?? 'USD',
                  },
                },
              },
            }
          : {}),
      },
    };
  },
  parseBookingResponse(json) {
    const output = asRecord(asRecord(json).output);
    const shipments = asArray(output.transactionShipments);
    const first = asRecord(shipments[0]);
    const awb = asString(first.masterTrackingNumber);
    if (!awb) throw new Error('FedEx booking response missing masterTrackingNumber');
    const pieceResponses = asArray(first.pieceResponses);
    const documents =
      pieceResponses.length > 0
        ? asArray(asRecord(pieceResponses[0]).packageDocuments)
        : [];
    const labelUrl =
      documents.length > 0 ? asString(asRecord(documents[0]).url) : undefined;
    return { awb, labelUrl };
  },
  buildTrackingRequest(awb) {
    return { path: `/track/v1/tracking/${encodeURIComponent(awb)}` };
  },
  parseTracking(json) {
    const output = asRecord(asRecord(json).output);
    const complete = asArray(output.completeTrackResults);
    const trackResults =
      complete.length > 0 ? asArray(asRecord(complete[0]).trackResults) : [];
    const result = asRecord(trackResults[0]);
    const trackingNumberInfo = asRecord(result.trackingNumberInfo);
    const latest = asRecord(result.latestStatusDetail);
    const status = asString(latest.description) ?? 'unknown';
    const code = asString(latest.code) ?? asString(latest.derivedCode);
    const events = asArray(result.scanEventList).map((entry) => {
      const e = asRecord(entry);
      return {
        at: asString(e.date),
        description: asString(e.eventDescription) ?? '',
        location: asString(e.scanLocation),
      };
    });
    return {
      awb: asString(trackingNumberInfo.trackingNumber) ?? '',
      status,
      delivered: code === 'DL' || status.toLowerCase() === 'delivered',
      events,
    };
  },
};

/** All bundled courier presets. */
export const COURIER_PRESETS: CourierPreset[] = [
  expergoPreset,
  tcsPreset,
  leopardsPreset,
  dhlPreset,
  fedexPreset,
];

/** Look up a preset by id; throws on unknown ids. */
export function getPreset(id: string): CourierPreset {
  const preset = COURIER_PRESETS.find((p) => p.id === id);
  if (!preset) {
    throw new Error(
      `Unknown courier preset "${id}". Known presets: ${COURIER_PRESETS.map((p) => p.id).join(', ')}`,
    );
  }
  return preset;
}
