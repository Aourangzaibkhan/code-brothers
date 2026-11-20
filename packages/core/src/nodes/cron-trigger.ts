import { defineNode } from '@code-brothers/node-sdk';
import { nextCronRun, parseCron } from '../cron.js';

/**
 * Cron Trigger — validates its 5-field cron expression and emits the next
 * scheduled run. The worker app uses the same parser to arm the schedule.
 */
export const cronTriggerNode = defineNode({
  type: 'core.cronTrigger',
  displayName: 'Cron Trigger',
  description: 'Starts the workflow on a cron schedule',
  version: 1,
  category: 'Triggers',
  trigger: true,
  inputs: { type: 'null', description: 'No input — fires on schedule' },
  outputs: {
    type: 'array',
    description: 'One item: { expression, triggeredAt, nextRun }',
  },
  parameters: [
    {
      name: 'expression',
      displayName: 'Cron Expression',
      type: 'string',
      required: true,
      description: '5-field cron expression, e.g. "0 9 * * 1-5"',
    },
  ],
  permissions: { network: { hosts: [] }, scopes: [], filesystem: 'none' },
  async execute(ctx) {
    const expression = ctx.parameters.expression;
    if (typeof expression !== 'string' || expression.trim() === '') {
      throw new Error('Cron Trigger requires an "expression" parameter');
    }
    const parsed = parseCron(expression); // throws CronError when invalid
    const now = new Date();
    const next = nextCronRun(parsed, now);
    return [
      [
        {
          json: {
            expression: parsed.expression,
            triggeredAt: now.toISOString(),
            nextRun: next.toISOString(),
          },
        },
      ],
    ];
  },
});
