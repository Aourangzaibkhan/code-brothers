import type { NodeDefinition } from '@code-brothers/node-sdk';
import { ecommerceLocalNodes } from './nodes.js';

export * from './webhook.js';
export * from './woocommerce.js';
export * from './sql.js';
export * from './invoice.js';
export * from './nodes.js';

/** All node definitions shipped by this connector. */
export const nodes: NodeDefinition[] = ecommerceLocalNodes;
