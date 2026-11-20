import { defineNode } from '@code-brothers/node-sdk';

/** No-Op — passes items through unchanged (placeholder / branch terminator). */
export const noopNode = defineNode({
  type: 'core.noop',
  displayName: 'No Operation',
  description: 'Passes items through unchanged',
  version: 1,
  category: 'Utility',
  inputs: { type: 'array' },
  outputs: { type: 'array', description: 'Input items, unchanged' },
  permissions: { network: { hosts: [] }, scopes: [], filesystem: 'none' },
  async execute(_ctx, input) {
    return [input];
  },
});
