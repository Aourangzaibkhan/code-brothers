import {
  defineNode,
  NodeRegistry,
  type NodeContext,
  type NodeDefinition,
} from '@code-brothers/node-sdk';
import { DarazClient, DARAZ_BASE_URLS, type DarazCountry } from './client.js';

export const DARAZ_CREDENTIAL_SLOT = 'darazApi';

async function clientFromContext(ctx: NodeContext): Promise<DarazClient> {
  const creds = await ctx.getCredentials(DARAZ_CREDENTIAL_SLOT);
  if (!creds || !creds.appKey || !creds.appSecret) {
    throw new Error(`Missing "${DARAZ_CREDENTIAL_SLOT}" credentials (appKey + appSecret required)`);
  }
  const countryRaw = creds.country ? String(creds.country) : 'pk';
  const country = (Object.keys(DARAZ_BASE_URLS).includes(countryRaw) ? countryRaw : 'pk') as DarazCountry;
  return new DarazClient({
    appKey: String(creds.appKey),
    appSecret: String(creds.appSecret),
    accessToken: creds.accessToken ? String(creds.accessToken) : undefined,
    country,
    fetch: ctx.fetch as unknown as typeof fetch,
  });
}

const credentialRequirement = [
  {
    name: DARAZ_CREDENTIAL_SLOT,
    displayName: 'Daraz API',
    required: true,
    fields: ['appKey', 'appSecret', 'accessToken', 'country'],
  },
];

const darazHosts = [
  'api.daraz.pk',
  'api.daraz.com.bd',
  'api.daraz.lk',
  'api.daraz.com.np',
  'api.daraz.com.mm',
  'auth.daraz.pk',
];

function extractOrders(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.orders)) return obj.orders as Record<string, unknown>[];
  }
  return [];
}

export const darazGetOrdersNode: NodeDefinition = defineNode({
  type: 'daraz.getOrders',
  displayName: 'Daraz: Get Orders',
  description: 'Lists Daraz orders created after an optional timestamp (one output item per order)',
  version: 1,
  category: 'Daraz',
  inputs: { type: 'array', description: 'Ignored except as a trigger' },
  outputs: { type: 'array', description: 'One item per order' },
  parameters: [
    { name: 'createdAfter', displayName: 'Created After (ISO)', type: 'string' },
    { name: 'status', displayName: 'Status', type: 'string' },
    { name: 'limit', displayName: 'Limit', type: 'number', default: 50 },
  ],
  credentials: credentialRequirement,
  permissions: { network: { hosts: darazHosts }, scopes: ['orders:read'] },
  async execute(ctx) {
    const client = await clientFromContext(ctx);
    const result = await client.getOrders({
      createdAfter: ctx.parameters.createdAfter ? String(ctx.parameters.createdAfter) : undefined,
      status: ctx.parameters.status ? String(ctx.parameters.status) : undefined,
      limit:
        ctx.parameters.limit !== undefined && ctx.parameters.limit !== null && ctx.parameters.limit !== ''
          ? Number(ctx.parameters.limit)
          : undefined,
    });
    return [extractOrders(result).map((o) => ({ json: o }))];
  },
});

export const darazUpdateStockNode: NodeDefinition = defineNode({
  type: 'daraz.updateStock',
  displayName: 'Daraz: Update Stock',
  description: 'Updates the stock quantity for a Daraz product by seller SKU',
  version: 1,
  category: 'Daraz',
  inputs: { type: 'array', description: 'Ignored except as a trigger' },
  outputs: { type: 'array', description: 'Update result for the SKU' },
  parameters: [
    { name: 'sellerSku', displayName: 'Seller SKU', type: 'string', required: true },
    { name: 'quantity', displayName: 'Quantity', type: 'number', required: true },
  ],
  credentials: credentialRequirement,
  permissions: { network: { hosts: darazHosts }, scopes: ['products:write'] },
  async execute(ctx) {
    const client = await clientFromContext(ctx);
    const sellerSku = String(ctx.parameters.sellerSku ?? '');
    const quantity = Number(ctx.parameters.quantity);
    const result = await client.updateStock(sellerSku, quantity);
    const json: Record<string, unknown> =
      result && typeof result === 'object' && !Array.isArray(result)
        ? { ...(result as Record<string, unknown>), sellerSku, quantity }
        : { sellerSku, quantity, result };
    return [[{ json }]];
  },
});

export const nodes: NodeDefinition[] = [darazGetOrdersNode, darazUpdateStockNode];

export function registerDarazNodes(registry: NodeRegistry): NodeRegistry {
  registry.registerAll(nodes);
  return registry;
}
