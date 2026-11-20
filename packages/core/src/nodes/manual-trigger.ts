import { defineNode } from '@code-brothers/node-sdk';

/** Manual Trigger — starts a workflow by hand, optionally with a payload. */
export const manualTriggerNode = defineNode({
  type: 'core.manualTrigger',
  displayName: 'Manual Trigger',
  description: 'Starts the workflow manually, optionally with a JSON payload',
  version: 1,
  category: 'Triggers',
  trigger: true,
  inputs: { type: 'null', description: 'No input — this node starts the flow' },
  outputs: { type: 'array', description: 'One item: the trigger payload' },
  parameters: [
    {
      name: 'payload',
      displayName: 'Payload',
      type: 'json',
      description: 'JSON object emitted when no run data is supplied',
    },
  ],
  permissions: { network: { hosts: [] }, scopes: [], filesystem: 'none' },
  async execute(ctx, input) {
    if (input.length > 0) return [input];
    const payload = ctx.parameters.payload;
    const json =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    return [[{ json }]];
  },
});
