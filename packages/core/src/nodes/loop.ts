import { defineNode, type NodeItem } from '@code-brothers/node-sdk';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Loop / Split in Batches (single-pass form) — expands an array field of
 * each input item into one output item per element, so downstream nodes run
 * once per element. Object elements become the item JSON directly; scalar
 * elements are wrapped as `{ value }`.
 */
export const loopNode = defineNode({
  type: 'core.loop',
  displayName: 'Loop',
  description: 'Emits one item per element of an array field on the input items',
  version: 1,
  category: 'Flow Control',
  inputs: { type: 'array', description: 'Items whose array field should be expanded' },
  outputs: { type: 'array', description: 'One item per array element' },
  parameters: [
    { name: 'arrayField', displayName: 'Array Field', type: 'string', default: 'items',
      description: 'Name of the array field on each item to iterate over' },
  ],
  permissions: { network: { hosts: [] }, scopes: [], filesystem: 'none' },
  async execute(ctx, input) {
    const field = String(ctx.parameters.arrayField ?? 'items');
    const out: NodeItem[] = [];
    for (const item of input) {
      const value = item.json[field];
      if (!Array.isArray(value)) {
        throw new Error(
          `Loop node expected field "${field}" to be an array, got ${value === null ? 'null' : typeof value}`,
        );
      }
      for (const [index, element] of value.entries()) {
        out.push({
          json: isPlainObject(element) ? { ...element } : { value: element },
          pairedItem: index,
        });
      }
    }
    return [out];
  },
});
