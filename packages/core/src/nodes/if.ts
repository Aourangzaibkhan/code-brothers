import { isDeepStrictEqual } from 'node:util';
import { defineNode, type NodeItem } from '@code-brothers/node-sdk';

export type ConditionOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'gt'
  | 'lt'
  | 'exists';

function isNumericLike(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' && value.trim() !== '') {
    return Number.isFinite(Number(value));
  }
  return false;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isNumericLike(a) && isNumericLike(b)) return Number(a) === Number(b);
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object'
  ) {
    return isDeepStrictEqual(a, b);
  }
  return false;
}

/** Evaluate one condition. Exported for direct unit testing. */
export function evaluateCondition(
  left: unknown,
  operator: ConditionOperator,
  right: unknown,
): boolean {
  switch (operator) {
    case 'equals':
      return valuesEqual(left, right);
    case 'notEquals':
      return !valuesEqual(left, right);
    case 'contains': {
      if (typeof left === 'string') return left.includes(String(right));
      if (Array.isArray(left)) {
        return left.some((entry) => valuesEqual(entry, right));
      }
      if (left && typeof left === 'object') {
        return Object.prototype.hasOwnProperty.call(left, String(right));
      }
      return false;
    }
    case 'gt':
    case 'lt': {
      if (isNumericLike(left) && isNumericLike(right)) {
        return operator === 'gt'
          ? Number(left) > Number(right)
          : Number(left) < Number(right);
      }
      const cmp = String(left).localeCompare(String(right));
      return operator === 'gt' ? cmp > 0 : cmp < 0;
    }
    case 'exists':
      return left !== undefined && left !== null;
    default:
      throw new Error(`Unknown IF operator "${String(operator)}"`);
  }
}

const OPERATORS: ConditionOperator[] = [
  'equals',
  'notEquals',
  'contains',
  'gt',
  'lt',
  'exists',
];

/** IF — routes each item to the true branch (0) or false branch (1). */
export const ifNode = defineNode({
  type: 'core.if',
  displayName: 'IF',
  description: 'Branches items by a condition: output 0 = true, output 1 = false',
  version: 1,
  category: 'Flow Control',
  inputs: { type: 'array' },
  outputs: { type: 'array', description: 'Two branches: [trueItems, falseItems]' },
  parameters: [
    { name: 'left', displayName: 'Value 1', type: 'string', required: true,
      description: 'Template/expression evaluated per item, e.g. {{ $json.total }}' },
    { name: 'operator', displayName: 'Operator', type: 'options', default: 'equals',
      options: OPERATORS.map((op) => ({ name: op, value: op })) },
    { name: 'right', displayName: 'Value 2', type: 'json',
      description: 'Comparison value (template string or literal). Ignored for "exists"' },
  ],
  permissions: { network: { hosts: [] }, scopes: [], filesystem: 'none' },
  async execute(ctx, input) {
    const params = ctx.parameters;
    const operator = (params.operator ?? 'equals') as ConditionOperator;
    if (!OPERATORS.includes(operator)) {
      throw new Error(`Unknown IF operator "${String(params.operator)}"`);
    }
    const trueItems: NodeItem[] = [];
    const falseItems: NodeItem[] = [];
    for (const item of input) {
      const left = ctx.renderTemplate(params.left, item.json);
      const right =
        typeof params.right === 'string'
          ? ctx.renderTemplate(params.right, item.json)
          : params.right;
      const result = evaluateCondition(left, operator, right);
      (result ? trueItems : falseItems).push(item);
    }
    return [trueItems, falseItems];
  },
});
