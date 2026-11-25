import {
  defineNode,
  renderParams,
  renderStringParam,
  NodeRegistry,
  type NodeDefinition,
  type NodeItem,
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
  itemJson: Record<string, unknown> = {},
): Promise<CourierClient> {
  const presetId = renderStringParam(ctx, 'preset', itemJson);
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
  itemJson: Record<string, unknown> = {},
): Party {
  const pick = (suffix: string, fallback: string): string => {
    const value = renderStringParam(ctx, `${prefix}${suffix}`, itemJson);
    return value !== '' ? value : fallback;
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
  async execute(ctx, input) {
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const out: NodeItem[] = [];
    for (const item of items) {
      const client = await buildClient(ctx, item.json);
      const sender = partyFromParams(ctx, 'sender', DEFAULT_SENDER, item.json);
      const receiver = partyFromParams(ctx, 'receiver', {
        name: '',
        phone: '',
        address: '',
        city: '',
        country: '',
      }, item.json);
      if (!receiver.name || !receiver.address) {
        throw new Error(
          'Courier Book Shipment node requires receiverName / receiverAddress parameters',
        );
      }
      const params = renderParams(ctx, item.json);
      const req: BookingRequest = {
        sender,
        receiver,
        weightKg: typeof params.weightKg === 'number' ? params.weightKg : 1,
        pieces: typeof params.pieces === 'number' ? params.pieces : 1,
        codAmount:
          typeof params.codAmount === 'number' ? params.codAmount : undefined,
        currency:
          typeof params.currency === 'string' ? params.currency : undefined,
        description:
          typeof params.description === 'string'
            ? params.description
            : undefined,
        serviceType:
          typeof params.serviceType === 'string'
            ? params.serviceType
            : undefined,
      };
      const result = await client.bookShipment(req);
      out.push({
        json: {
          ...item.json,
          awb: result.awb,
          labelUrl: result.labelUrl ?? null,
          preset: client.preset.id,
          raw: result.raw as Record<string, unknown>,
        },
      });
    }
    return [out];
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
  async execute(ctx, input) {
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const out: NodeItem[] = [];
    for (const item of items) {
      const awb = renderStringParam(ctx, 'awb', item.json);
      if (awb === '') {
        throw new Error('Courier Track node requires an "awb" parameter');
      }
      const client = await buildClient(ctx, item.json);
      const tracking = await client.track(awb);
      out.push({
        json: {
          ...item.json,
          awb: tracking.awb,
          status: tracking.status,
          delivered: tracking.delivered,
          events: tracking.events as unknown as Record<string, unknown>[],
          preset: client.preset.id,
        },
      });
    }
    return [out];
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
