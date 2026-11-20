import { defineNode, type NodeItem } from '@code-brothers/node-sdk';

export interface SetDataAssignment {
  name: string;
  /** Template string (rendered per item) or literal value. */
  value: unknown;
}

/**
 * Set Data — maps/renames fields using expressions. Each assignment value is
 * rendered per item, so `{{ $json.price * 2 }}` keeps its number type.
 * With `keepOnlySet: true` the output contains only the assigned fields.
 */
export const setDataNode = defineNode({
  type: 'core.setData',
  displayName: 'Set Data',
  description: 'Sets, maps or renames item fields using expressions',
  version: 1,
  category: 'Data',
  inputs: { type: 'array' },
  outputs: { type: 'array', description: 'Items with the assigned fields applied' },
  parameters: [
    { name: 'assignments', displayName: 'Assignments', type: 'collection',
      description: 'Array of { name, value } — value may be a {{ template }}' },
    { name: 'fields', displayName: 'Fields', type: 'json',
      description: 'Alternative form: object of field name -> template/value' },
    { name: 'keepOnlySet', displayName: 'Keep Only Set Fields', type: 'boolean', default: false },
  ],
  permissions: { network: { hosts: [] }, scopes: [], filesystem: 'none' },
  async execute(ctx, input) {
    const params = ctx.parameters;
    const assignments: SetDataAssignment[] = [];
    if (Array.isArray(params.assignments)) {
      for (const entry of params.assignments as SetDataAssignment[]) {
        if (entry && typeof entry.name === 'string') assignments.push(entry);
      }
    }
    if (params.fields && typeof params.fields === 'object') {
      for (const [name, value] of Object.entries(
        params.fields as Record<string, unknown>,
      )) {
        assignments.push({ name, value });
      }
    }
    const keepOnlySet = params.keepOnlySet === true;

    const out: NodeItem[] = input.map((item) => {
      const json: Record<string, unknown> = keepOnlySet
        ? {}
        : { ...item.json };
      for (const assignment of assignments) {
        json[assignment.name] =
          typeof assignment.value === 'string'
            ? ctx.renderTemplate(assignment.value, item.json)
            : assignment.value;
      }
      return { json, ...(item.pairedItem !== undefined ? { pairedItem: item.pairedItem } : {}) };
    });
    return [out];
  },
});
