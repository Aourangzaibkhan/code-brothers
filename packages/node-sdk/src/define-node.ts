import type { NodeDefinition } from './types.js';

/**
 * Define a node. This is an identity helper: it gives connector authors full
 * type inference on the definition object and validates the minimum contract
 * (a type id and an execute function) at module load time, so a malformed
 * plugin fails fast at startup instead of mid-workflow.
 */
export function defineNode(definition: NodeDefinition): NodeDefinition {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('defineNode expects a node definition object');
  }
  if (typeof definition.type !== 'string' || definition.type.trim() === '') {
    throw new TypeError('Node definition requires a non-empty "type" id');
  }
  if (typeof definition.execute !== 'function') {
    throw new TypeError(
      `Node "${definition.type}" requires an execute(ctx, input) function`,
    );
  }
  if (!definition.inputs || typeof definition.inputs !== 'object') {
    throw new TypeError(`Node "${definition.type}" requires an "inputs" schema`);
  }
  if (!definition.outputs || typeof definition.outputs !== 'object') {
    throw new TypeError(`Node "${definition.type}" requires an "outputs" schema`);
  }
  return definition;
}
