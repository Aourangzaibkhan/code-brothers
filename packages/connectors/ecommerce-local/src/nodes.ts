import {
  defineNode,
  renderParams,
  renderStringParam,
  renderValue,
  NodeRegistry,
  type NodeDefinition,
  type NodeItem,
} from '@code-brothers/node-sdk';
import { SqlStoreConnector } from './sql.js';
import { WebhookEmitter } from './webhook.js';
import { WooCommerceClient } from './woocommerce.js';

const LOCAL_STORE_CREDENTIAL = {
  name: 'localStore',
  displayName: 'Local Store',
  required: true,
  fields: [
    'connectionString',
    'webhookSecret',
    'storeUrl',
    'consumerKey',
    'consumerSecret',
  ],
};

/**
 * Run a parameterized SQL query against the local store database.
 *
 * Test/embedding hook: when `ctx.variables.sqlConnector` is a
 * {@link SqlStoreConnector} instance it is used directly (so tests can
 * inject a connector backed by a fake queryable); otherwise a connector is
 * built from the `localStore` credential's `connectionString`.
 */
export const localDbQueryNode = defineNode({
  type: 'local.dbQuery',
  displayName: 'Local DB Query',
  description:
    'Runs a parameterized SQL query ($1..$n placeholders) against the local store database and outputs the rows',
  version: 1,
  category: 'Ecommerce (Local)',
  inputs: { type: 'array', description: 'Input items (ignored except as trigger)' },
  outputs: { type: 'array', description: 'One item per result row' },
  parameters: [
    {
      name: 'sql',
      displayName: 'SQL',
      type: 'string',
      required: true,
      description: 'SQL text with $1..$n placeholders — never interpolate values',
    },
    {
      name: 'valuesJson',
      displayName: 'Values (JSON array)',
      type: 'string',
      default: '[]',
      description: 'JSON array of bound values for the placeholders',
    },
  ],
  credentials: [LOCAL_STORE_CREDENTIAL],
  permissions: {
    network: { hosts: [] },
    scopes: ['db:query'],
    filesystem: 'none',
    description: 'Database access only, via the configured connection string',
  },
  async execute(ctx, input) {
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    let connector: SqlStoreConnector | undefined;
    const hook = ctx.variables.sqlConnector;
    if (hook instanceof SqlStoreConnector) {
      // Documented test/embedding hook — see the node description above.
      connector = hook;
    } else {
      const credentials = await ctx.getCredentials('localStore');
      const connectionString = credentials?.connectionString;
      if (typeof connectionString !== 'string' || connectionString === '') {
        throw new Error(
          'Local DB Query node requires the localStore credential field "connectionString" (or a SqlStoreConnector in ctx.variables.sqlConnector)',
        );
      }
      connector = new SqlStoreConnector({ connectionString });
    }

    try {
      const out: NodeItem[] = [];
      for (const item of items) {
        const sql = renderStringParam(ctx, 'sql', item.json);
        if (sql.trim() === '') {
          throw new Error('Local DB Query node requires a "sql" parameter');
        }
        const valuesRaw = renderValue(ctx, ctx.parameters.valuesJson, item.json);
        let values: unknown[] = [];
        if (typeof valuesRaw === 'string' && valuesRaw.trim() !== '') {
          const parsed = JSON.parse(valuesRaw) as unknown;
          if (!Array.isArray(parsed)) {
            throw new Error('"valuesJson" must be a JSON array');
          }
          values = parsed;
        } else if (Array.isArray(valuesRaw)) {
          values = valuesRaw;
        }
        const { rows, rowCount } = await connector.query(sql, values);
        if (rows.length === 0) {
          // A write (INSERT/UPDATE/DELETE) returns no rows: pass the item
          // through annotated, so the chain keeps flowing.
          out.push({
            json: { ...item.json, affectedRows: rowCount ?? 0 },
          });
        }
        for (const row of rows) {
          out.push({
            json: {
              ...item.json,
              ...(row && typeof row === 'object'
                ? (row as Record<string, unknown>)
                : { value: row }),
            },
          });
        }
      }
      return [out];
    } finally {
      if (!(hook instanceof SqlStoreConnector)) {
        await connector.end().catch(() => undefined);
      }
    }
  },
});

/**
 * Send the input items' JSON as a signed webhook event. The shared secret
 * comes from the `localStore` credential field `webhookSecret`.
 */
export const localSendWebhookNode = defineNode({
  type: 'local.sendWebhook',
  displayName: 'Local Send Webhook',
  description:
    'POSTs each input item as a signed (HMAC-SHA256) webhook event to a URL',
  version: 1,
  category: 'Ecommerce (Local)',
  inputs: { type: 'array', description: 'Items whose JSON becomes the event data' },
  outputs: {
    type: 'array',
    description: 'One item per delivery with { event, status, responseBody }',
  },
  parameters: [
    { name: 'url', displayName: 'URL', type: 'string', required: true },
    {
      name: 'event',
      displayName: 'Event',
      type: 'string',
      required: true,
      default: 'order.created',
      description: 'e.g. order.created, lead.submitted, payment.received',
    },
  ],
  credentials: [LOCAL_STORE_CREDENTIAL],
  permissions: {
    network: { hosts: ['*'] },
    scopes: ['webhook:send'],
    filesystem: 'none',
  },
  async execute(ctx, input) {
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const url = renderStringParam(ctx, 'url', items[0]?.json ?? {});
    const event = renderStringParam(ctx, 'event', items[0]?.json ?? {});
    if (url === '') {
      throw new Error('Local Send Webhook node requires a "url" parameter');
    }
    if (event === '') {
      throw new Error('Local Send Webhook node requires an "event" parameter');
    }
    const credentials = await ctx.getCredentials('localStore');
    const secret = credentials?.webhookSecret;
    if (typeof secret !== 'string' || secret === '') {
      throw new Error(
        'Local Send Webhook node requires the localStore credential field "webhookSecret"',
      );
    }
    const emitter = new WebhookEmitter({
      url,
      secret,
      fetch: ctx.fetch as typeof fetch,
      source: 'code-brothers/local.sendWebhook',
    });
    const out: NodeItem[] = [];
    for (const [index, item] of items.entries()) {
      const result = await emitter.emit(event, item.json);
      out.push({
        json: {
          ...item.json,
          event,
          status: result.status,
          responseBody: result.body,
          data: item.json,
        },
        pairedItem: index,
      });
    }
    return [out];
  },
});

/** Fetch orders from a WooCommerce store (Basic auth over HTTPS, OAuth over HTTP). */
export const wooGetOrdersNode = defineNode({
  type: 'local.wooGetOrders',
  displayName: 'WooCommerce Get Orders',
  description: 'Lists orders from the WooCommerce store in the localStore credential',
  version: 1,
  category: 'Ecommerce (Local)',
  inputs: { type: 'array', description: 'Input items (ignored except as trigger)' },
  outputs: { type: 'array', description: 'One item per order' },
  parameters: [
    {
      name: 'status',
      displayName: 'Status',
      type: 'options',
      options: [
        { name: 'Any', value: 'any' },
        { name: 'Pending', value: 'pending' },
        { name: 'Processing', value: 'processing' },
        { name: 'Completed', value: 'completed' },
        { name: 'Cancelled', value: 'cancelled' },
        { name: 'Refunded', value: 'refunded' },
      ],
      description: 'Order status filter (omit for the store default)',
    },
    {
      name: 'perPage',
      displayName: 'Per Page',
      type: 'number',
      default: 10,
    },
  ],
  credentials: [LOCAL_STORE_CREDENTIAL],
  permissions: {
    network: { hosts: ['*'] },
    scopes: ['orders:read'],
    filesystem: 'none',
  },
  async execute(ctx, input) {
    const credentials = await ctx.getCredentials('localStore');
    const storeUrl = credentials?.storeUrl;
    const consumerKey = credentials?.consumerKey;
    const consumerSecret = credentials?.consumerSecret;
    if (
      typeof storeUrl !== 'string' ||
      typeof consumerKey !== 'string' ||
      typeof consumerSecret !== 'string'
    ) {
      throw new Error(
        'WooCommerce Get Orders node requires localStore credential fields "storeUrl", "consumerKey" and "consumerSecret"',
      );
    }
    const client = new WooCommerceClient({
      storeUrl,
      consumerKey,
      consumerSecret,
      fetch: ctx.fetch as typeof fetch,
    });
    const params = renderParams(ctx, input[0]?.json ?? {});
    const query: Record<string, unknown> = {};
    const status = params.status;
    if (typeof status === 'string' && status !== '' && status !== 'any') {
      query.status = status;
    }
    const perPage = params.perPage;
    if (typeof perPage === 'number' && perPage > 0) {
      query.per_page = perPage;
    }
    const orders = await client.getOrders<unknown>(query);
    const list = Array.isArray(orders) ? orders : [];
    const out: NodeItem[] = list.map((order, index) => ({
      json:
        order && typeof order === 'object'
          ? (order as Record<string, unknown>)
          : { value: order },
      pairedItem: index,
    }));
    return [out];
  },
});

/** All ecommerce-local node definitions. */
export const ecommerceLocalNodes: NodeDefinition[] = [
  localDbQueryNode,
  localSendWebhookNode,
  wooGetOrdersNode,
];

/** Register all ecommerce-local nodes on a registry. */
export function registerEcommerceLocalNodes(
  registry: NodeRegistry,
): NodeRegistry {
  return registry.registerAll(ecommerceLocalNodes);
}
