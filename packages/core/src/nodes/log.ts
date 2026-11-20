import { defineNode } from '@code-brothers/node-sdk';

/** Log — writes each item to the (redacted) execution log, passes items on. */
export const logNode = defineNode({
  type: 'core.log',
  displayName: 'Log',
  description: 'Logs a message per item to the execution log and passes items through',
  version: 1,
  category: 'Utility',
  inputs: { type: 'array' },
  outputs: { type: 'array', description: 'Input items, unchanged' },
  parameters: [
    { name: 'message', displayName: 'Message', type: 'string',
      description: 'Template rendered per item; defaults to the item JSON' },
    { name: 'level', displayName: 'Level', type: 'options', default: 'info',
      options: [
        { name: 'debug', value: 'debug' },
        { name: 'info', value: 'info' },
        { name: 'warn', value: 'warn' },
        { name: 'error', value: 'error' },
      ] },
  ],
  permissions: { network: { hosts: [] }, scopes: [], filesystem: 'none' },
  async execute(ctx, input) {
    const level = (ctx.parameters.level ?? 'info') as
      | 'debug'
      | 'info'
      | 'warn'
      | 'error';
    const template = ctx.parameters.message;
    for (const item of input) {
      const message =
        typeof template === 'string'
          ? String(ctx.renderTemplate(template, item.json) ?? '')
          : 'log';
      ctx.logger[level](message, { nodeId: ctx.nodeId, item: item.json });
    }
    return [input];
  },
});
