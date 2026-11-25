import { defineNode } from '@code-brothers/node-sdk';

/**
 * Aggregate — collapses all input items into one summary item.
 *
 * Built for digest/report workflows (template-10): orders arrive from
 * several providers at once, each with its own amount field name, and the
 * digest needs a count + a total. `sumFields` is a comma-separated list of
 * candidate numeric fields tried in order per item (first numeric value
 * wins); items with none of them still count toward the total.
 */
export const aggregateNode = defineNode({
  type: 'core.aggregate',
  displayName: 'Aggregate',
  description:
    'Counts all input items and sums a numeric field across them into one summary item',
  version: 1,
  category: 'Data',
  inputs: { type: 'array', description: 'Items to summarise' },
  outputs: {
    type: 'array',
    description: 'One item with { <countName>, <sumName>, digestText? }',
  },
  parameters: [
    {
      name: 'sumFields',
      displayName: 'Sum Fields (comma separated)',
      type: 'string',
      default: 'total_price,total,price,amount',
      description:
        'Candidate numeric fields, tried in order per item; first numeric value wins',
    },
    {
      name: 'countName',
      displayName: 'Count Field Name',
      type: 'string',
      default: 'totalOrders',
    },
    {
      name: 'sumName',
      displayName: 'Sum Field Name',
      type: 'string',
      default: 'totalRevenue',
    },
    {
      name: 'textTemplate',
      displayName: 'Summary Text Template',
      type: 'string',
      description:
        'Optional template rendered against the summary item; result is stored as digestText',
    },
  ],
  permissions: { network: { hosts: [] }, scopes: [], filesystem: 'none' },
  async execute(ctx, input) {
    const params = ctx.parameters;
    const sumFields = String(params.sumFields ?? 'total_price,total,price,amount')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    const countName =
      typeof params.countName === 'string' && params.countName !== ''
        ? params.countName
        : 'totalOrders';
    const sumName =
      typeof params.sumName === 'string' && params.sumName !== ''
        ? params.sumName
        : 'totalRevenue';

    let total = 0;
    for (const item of input) {
      for (const field of sumFields) {
        const value = item.json[field];
        if (typeof value === 'number' && Number.isFinite(value)) {
          total += value;
          break;
        }
        if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
          total += Number(value);
          break;
        }
      }
    }

    const summary: Record<string, unknown> = {
      [countName]: input.length,
      [sumName]: Math.round(total * 100) / 100,
    };
    const textTemplate = params.textTemplate;
    if (typeof textTemplate === 'string' && textTemplate !== '') {
      summary.digestText = ctx.renderTemplate(textTemplate, summary);
    }
    return [[{ json: summary }]];
  },
});
