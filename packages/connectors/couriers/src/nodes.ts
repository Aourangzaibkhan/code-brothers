import {
  defineNode,
  NodeRegistry,
  type NodeDefinition,
} from '@code-brothers/node-sdk';
import { CourierClient, type CourierCredentials } from './client.js';
import { COURIER_PRESETS, type BookingRequest, type Party } from './presets.js';

const COURIER_CREDENTIAL = {
  name: 'courierApi',
  displayName: 'Courier API',
  required: true,
  fields: ['apiKey', 'token', 'username', 'password', 'baseUrl'],
};

const PRESET_OPTIONS = COURIER_PRESETS.map((p) => ({
  name: `${p.name} (${p.region})`,
  value: p.id,
}));

async function buildClient(
  ctx: Parameters<NodeDefinition['execute']>[0],
): Promise<CourierClient> {
  const presetId = ctx.parameters.preset;
  if (typeof presetId !== 'string' || presetId === '') {
    throw new Error('Courier node requires a "preset" parameter');
  }
  const credentials = (await ctx.getCredentials('courierApi')) ?? {};
  const clientCredentials: CourierCredentials = {
    apiKey: typeof credentials.apiKey === 'string' ? credentials.apiKey : undefined,
    token: typeof credentials.token === 'string' ? credentials.token : undefined,
    username:
      typeof credentials.username === 'string' ? credentials.username : undefined,
    password:
      typeof credentials.password === 'string' ? credentials.password : undefined,
  };
  return new CourierClient({
    preset: presetId,
    credentials: clientCredentials,
    fetch: ctx.fetch as typeof fetch,
    baseUrl:
      typeof credentials.baseUrl === 'string' && credentials.baseUrl !== ''
        ? credentials.baseUrl
        : undefined,
  });
}

function partyFromParams(
  ctx: Parameters<NodeDefinition['execute']>[0],
  prefix: 'sender' | 'receiver',
  defaults: Party,
): Party {
  const pick = (suffix: string, fallback: string): string => {
    const value = ctx.parameters[`${prefix}${suffix}`];
    return typeof value === 'string' && value !== '' ? value : fallback;
  };
  return {
    name: pick('Name', defaults.name),
    phone: pick('Phone', defaults.phone),
    address: pick('Address', defaults.address),
    city: pick('City', defaults.city),
    country: pick('Country', defaults.country),
  };
}

const DEFAULT_SENDER: Party = {
  name: 'Code Brothers Warehouse',
  phone: '+971500000000',
  address: 'Warehouse 1, Industrial Area',
  city: 'Dubai',
  country: 'AE',
};

/** Book a shipment with any bundled courier preset. */
export const courierBookShipmentNode = defineNode({
  type: 'courier.bookShipment',
  displayName: 'Courier Book Shipment',
  description: 'Books a shipment with ExperGo, TCS, Leopards, DHL or FedEx',
  version: 1,
  category: 'Couriers',
  inputs: { type: 'array', description: 'Input items (ignored except as trigger)' },
  outputs: {
    type: 'array',
    description: 'One item with { awb, labelUrl, raw }',
  },
  parameters: [
    {
      name: 'preset',
      displayName: 'Courier',
      type: 'options',
      required: true,
      default: 'expergo',
      options: PRESET_OPTIONS,
    },
    { name: 'senderName', displayName: 'Sender Name', type: 'string', default: DEFAULT_SENDER.name },
    { name: 'senderPhone', displayName: 'Sender Phone', type: 'string', default: DEFAULT_SENDER.phone },
    { name: 'senderAddress', displayName: 'Sender Address', type: 'string', default: DEFAULT_SENDER.address },
    { name: 'senderCity', displayName: 'Sender City', type: 'string', default: DEFAULT_SENDER.city },
    { name: 'senderCountry', displayName: 'Sender Country', type: 'string', default: DEFAULT_SENDER.country },
    { name: 'receiverName', displayName: 'Receiver Name', type: 'string', required: true },
    { name: 'receiverPhone', displayName: 'Receiver Phone', type: 'string', required: true },
    { name: 'receiverAddress', displayName: 'Receiver Address', type: 'string', required: true },
    { name: 'receiverCity', displayName: 'Receiver City', type: 'string', required: true },
    { name: 'receiverCountry', displayName: 'Receiver Country', type: 'string', required: true },
    { name: 'weightKg', displayName: 'Weight (kg)', type: 'number', default: 1 },
    { name: 'pieces', displayName: 'Pieces', type: 'number', default: 1 },
    { name: 'codAmount', displayName: 'COD Amount', type: 'number' },
    { name: 'currency', displayName: 'Currency', type: 'string' },
    { name: 'description', displayName: 'Description', type: 'string' },
    { name: 'serviceType', displayName: 'Service Type', type: 'string' },
  ],
  credentials: [COURIER_CREDENTIAL],
  permissions: {
    network: { hosts: ['*'] },
    scopes: ['shipments:book'],
    filesystem: 'none',
  },
  async execute(ctx) {
    const client = await buildClient(ctx);
    const sender = partyFromParams(ctx, 'sender', DEFAULT_SENDER);
    const receiver = partyFromParams(ctx, 'receiver', {
      name: '',
      phone: '',
      address: '',
      city: '',
      country: '',
    });
    if (!receiver.name || !receiver.address) {
      throw new Error(
        'Courier Book Shipment node requires receiverName / receiverAddress parameters',
      );
    }
    const req: BookingRequest = {
      sender,
      receiver,
      weightKg: typeof ctx.parameters.weightKg === 'number' ? ctx.parameters.weightKg : 1,
      pieces: typeof ctx.parameters.pieces === 'number' ? ctx.parameters.pieces : 1,
      codAmount:
        typeof ctx.parameters.codAmount === 'number' ? ctx.parameters.codAmount : undefined,
      currency:
        typeof ctx.parameters.currency === 'string' ? ctx.parameters.currency : undefined,
      description:
        typeof ctx.parameters.description === 'string'
          ? ctx.parameters.description
          : undefined,
      serviceType:
        typeof ctx.parameters.serviceType === 'string'
          ? ctx.parameters.serviceType
          : undefined,
    };
    const result = await client.bookShipment(req);
    return [
      [
        {
          json: {
            awb: result.awb,
            labelUrl: result.labelUrl ?? null,
            preset: client.preset.id,
            raw: result.raw as Record<string, unknown>,
          },
        },
      ],
    ];
  },
});

/** Track a shipment by AWB with any bundled courier preset. */
export const courierTrackNode = defineNode({
  type: 'courier.track',
  displayName: 'Courier Track Shipment',
  description: 'Returns normalized tracking status + events for an AWB',
  version: 1,
  category: 'Couriers',
  inputs: { type: 'array', description: 'Input items (ignored except as trigger)' },
  outputs: {
    type: 'array',
    description: 'One item with { awb, status, delivered, events }',
  },
  parameters: [
    {
      name: 'preset',
      displayName: 'Courier',
      type: 'options',
      required: true,
      default: 'expergo',
      options: PRESET_OPTIONS,
    },
    { name: 'awb', displayName: 'AWB / Tracking Number', type: 'string', required: true },
  ],
  credentials: [COURIER_CREDENTIAL],
  permissions: {
    network: { hosts: ['*'] },
    scopes: ['shipments:track'],
    filesystem: 'none',
  },
  async execute(ctx) {
    const awb = ctx.parameters.awb;
    if (typeof awb !== 'string' || awb === '') {
      throw new Error('Courier Track node requires an "awb" parameter');
    }
    const client = await buildClient(ctx);
    const tracking = await client.track(awb);
    return [
      [
        {
          json: {
            awb: tracking.awb,
            status: tracking.status,
            delivered: tracking.delivered,
            events: tracking.events as unknown as Record<string, unknown>[],
            preset: client.preset.id,
          },
        },
      ],
    ];
  },
});

/** All courier node definitions. */
export const courierNodes: NodeDefinition[] = [
  courierBookShipmentNode,
  courierTrackNode,
];

/** Register all courier nodes on a registry. */
export function registerCourierNodes(registry: NodeRegistry): NodeRegistry {
  return registry.registerAll(courierNodes);
}
