import { createCoreNodeRegistry } from '@code-brothers/core';
import {
  NodeRegistry,
  type NodeDefinition,
} from '@code-brothers/node-sdk';
import { nodes as coreUtilityNodes } from '@code-brothers/connector-core-nodes';
import { courierNodes } from '@code-brothers/connector-couriers';
import { nodes as darazNodes } from '@code-brothers/connector-daraz';
import { ecommerceLocalNodes } from '@code-brothers/connector-ecommerce-local';
import { nodes as instagramNodes } from '@code-brothers/connector-instagram';
import { nodes as shopifyNodes } from '@code-brothers/connector-shopify';
import { whatsappNodes } from '@code-brothers/connector-whatsapp';
import { nodes as youtubeNodes } from '@code-brothers/connector-youtube';

/**
 * Every node definition shipped with the platform, in one place.
 * The API and the worker both build their engines from this list — a
 * template may reference any of these types and it will resolve.
 */
export const allConnectorNodes: NodeDefinition[] = [
  ...coreUtilityNodes,
  ...courierNodes,
  ...darazNodes,
  ...ecommerceLocalNodes,
  ...instagramNodes,
  ...shopifyNodes,
  ...whatsappNodes,
  ...youtubeNodes,
];

/**
 * A registry with the core nodes plus every connector node. This is what
 * the production API and worker use; `createEngine()` (core only) is for
 * tests and for deployments that deliberately run without connectors.
 */
export function createPlatformRegistry(): NodeRegistry {
  const registry = createCoreNodeRegistry();
  registry.registerAll(allConnectorNodes);
  return registry;
}
