import {
  defineNode,
  renderParams,
  renderValue,
  NodeRegistry,
  type NodeContext,
  type NodeDefinition,
  type NodeItem,
} from '@code-brothers/node-sdk';
import { ShopifyClient } from './client.js';

export const SHOPIFY_CREDENTIAL_SLOT = 'shopifyApi';

async function clientFromContext(ctx: NodeContext): Promise<ShopifyClient> {
  const creds = await ctx.getCredentials(SHOPIFY_CREDENTIAL_SLOT);
  if (!creds || !creds.shop || !creds.accessToken) {
    throw new Error(`Missing "${SHOPIFY_CREDENTIAL_SLOT}" credentials (shop + accessToken required)`);
  }
  return new ShopifyClient({
    shop: String(creds.shop),
    accessToken: String(creds.accessToken),
    apiVersion: creds.apiVersion ? String(creds.apiVersion) : undefined,
    // Optional override (sandbox / local mock) — omit for the real API.
    baseUrl: creds.baseUrl ? String(creds.baseUrl) : undefined,
    fetch: ctx.fetch as unknown as typeof fetch,
  });
}

function asId(value: unknown): string | number {
  if (typeof value === 'number') return value;
  const s = String(value);
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) ? n : s;
}

const credentialRequirement = [
  {
    name: SHOPIFY_CREDENTIAL_SLOT,
    displayName: 'Shopify API',
    required: true,
    fields: ['shop', 'accessToken', 'apiVersion', 'baseUrl'],
  },
];

export const shopifyGetOrdersNode: NodeDefinition = defineNode({
  type: 'shopify.getOrders',
  displayName: 'Shopify: Get Orders',
  description: 'Lists orders from a Shopify store (one output item per order)',
  version: 1,
  category: 'Shopify',
  inputs: { type: 'array', description: 'Ignored except as a trigger' },
  outputs: { type: 'array', description: 'One item per order' },
  parameters: [
    {
      name: 'status',
      displayName: 'Status',
      type: 'options',
      default: 'any',
      options: [
        { name: 'Any', value: 'any' },
        { name: 'Open', value: 'open' },
        { name: 'Closed', value: 'closed' },
        { name: 'Cancelled', value: 'cancelled' },
      ],
    },
    { name: 'limit', displayName: 'Limit', type: 'number', default: 50 },
  ],
  credentials: credentialRequirement,
  permissions: {
    network: { hosts: ['*.myshopify.com'] },
    scopes: ['read_orders'],
  },
  async execute(ctx, input) {
    const client = await clientFromContext(ctx);
    // List node: one provider call; parameters rendered against the first
    // input item so `$vars.*` / `$json.*` from the trigger still resolve.
    const params = renderParams(ctx, input[0]?.json ?? {});
    const query: Record<string, string | number> = {};
    if (params.status) query.status = String(params.status);
    if (params.limit !== undefined && params.limit !== null && params.limit !== '') {
      query.limit = Number(params.limit);
    }
    const orders = await client.getOrders(query);
    return [orders.map((o) => ({ json: o as Record<string, unknown> }))];
  },
});

export const shopifyCreateDraftOrderNode: NodeDefinition = defineNode({
  type: 'shopify.createDraftOrder',
  displayName: 'Shopify: Create Draft Order',
  description: 'Creates a draft order from line items (JSON parameter or input items)',
  version: 1,
  category: 'Shopify',
  inputs: { type: 'array', description: 'Optional line-item items used when lineItemsJson is empty' },
  outputs: { type: 'array', description: 'The created draft order' },
  parameters: [
    { name: 'email', displayName: 'Customer Email', type: 'string' },
    {
      name: 'lineItemsJson',
      displayName: 'Line Items (JSON)',
      type: 'json',
      description: 'JSON array of Shopify draft-order line items, e.g. [{"variant_id":123,"quantity":1}]',
    },
  ],
  credentials: credentialRequirement,
  permissions: {
    network: { hosts: ['*.myshopify.com'] },
    scopes: ['write_draft_orders'],
  },
  async execute(ctx, input) {
    const client = await clientFromContext(ctx);
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const out: NodeItem[] = [];
    for (const item of items) {
      let lineItems: unknown[] = [];
      const raw = renderValue(ctx, ctx.parameters.lineItemsJson, item.json);
      if (typeof raw === 'string' && raw.trim() !== '') {
        lineItems = JSON.parse(raw) as unknown[];
      } else if (Array.isArray(raw)) {
        lineItems = raw;
      } else {
        lineItems = [item.json];
      }
      const draftOrder: Record<string, unknown> = { line_items: lineItems };
      const email = renderValue(ctx, ctx.parameters.email, item.json);
      if (email) draftOrder.email = String(email);
      const created = await client.createDraftOrder(draftOrder);
      out.push({ json: { ...item.json, ...(created as Record<string, unknown>) } });
    }
    return [out];
  },
});

export const shopifyUpdateInventoryNode: NodeDefinition = defineNode({
  type: 'shopify.updateInventory',
  displayName: 'Shopify: Update Inventory',
  description: 'Sets the available inventory level for an item at a location',
  version: 1,
  category: 'Shopify',
  inputs: { type: 'array', description: 'Ignored except as a trigger' },
  outputs: { type: 'array', description: 'The updated inventory level' },
  parameters: [
    { name: 'locationId', displayName: 'Location ID', type: 'string', required: true },
    { name: 'inventoryItemId', displayName: 'Inventory Item ID', type: 'string', required: true },
    { name: 'available', displayName: 'Available', type: 'number', required: true },
  ],
  credentials: credentialRequirement,
  permissions: {
    network: { hosts: ['*.myshopify.com'] },
    scopes: ['write_inventory'],
  },
  async execute(ctx, input) {
    const client = await clientFromContext(ctx);
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const out: NodeItem[] = [];
    for (const item of items) {
      const params = renderParams(ctx, item.json);
      const level = await client.setInventoryLevel({
        locationId: asId(params.locationId),
        inventoryItemId: asId(params.inventoryItemId),
        available: Number(params.available),
      });
      out.push({ json: { ...item.json, ...(level as Record<string, unknown>) } });
    }
    return [out];
  },
});

export const nodes: NodeDefinition[] = [
  shopifyGetOrdersNode,
  shopifyCreateDraftOrderNode,
  shopifyUpdateInventoryNode,
];

export function registerShopifyNodes(registry: NodeRegistry): NodeRegistry {
  registry.registerAll(nodes);
  return registry;
}
