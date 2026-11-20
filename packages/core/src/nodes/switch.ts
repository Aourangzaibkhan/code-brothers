import { defineNode, type NodeItem } from '@code-brothers/node-sdk';
import { valuesEqual } from './if.js';

export interface SwitchCase {
  /** Value the evaluated input is compared against (equality semantics of the IF node). */
  match: unknown;
}

/**
 * Switch — evaluates a value per item and routes the item to the branch of
 * the first matching case. The last branch is the default (no match).
 * Branches: [case0, case1, ..., caseN, default].
 */
export const switchNode = defineNode({
  type: 'core.switch',
  displayName: 'Switch',
  description: 'Routes items to one of several branches by value, with a default branch',
  version: 1,
  category: 'Flow Control',
  inputs: { type: 'array' },
  outputs: { type: 'array', description: 'One branch per case, plus a final default branch' },
  parameters: [
    { name: 'value', displayName: 'Value', type: 'string', required: true,
      description: 'Template/expression evaluated per item, e.g. {{ $json.status }}' },
    { name: 'cases', displayName: 'Cases', type: 'collection', required: true,
      description: 'Array of { match } entries, in branch order' },
  ],
  permissions: { network: { hosts: [] }, scopes: [], filesystem: 'none' },
  async execute(ctx, input) {
    const cases = ctx.parameters.cases;
    if (!Array.isArray(cases)) {
      throw new Error('Switch node requires a "cases" array parameter');
    }
    const branches: NodeItem[][] = cases.map(() => []);
    branches.push([]); // default branch
    const defaultBranch = branches.length - 1;

    for (const item of input) {
      const value = ctx.renderTemplate(ctx.parameters.value, item.json);
      let target = defaultBranch;
      for (const [index, entry] of cases.entries()) {
        const match = (entry as SwitchCase)?.match;
        const renderedMatch =
          typeof match === 'string'
            ? ctx.renderTemplate(match, item.json)
            : match;
        if (valuesEqual(value, renderedMatch)) {
          target = index;
          break;
        }
      }
      branches[target]!.push(item);
    }
    return branches;
  },
});
