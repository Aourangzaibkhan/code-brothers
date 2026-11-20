import { defineNode } from '@code-brothers/node-sdk';

/** Hard cap for a single Wait so a workflow cannot sleep forever. */
export const MAX_WAIT_MS = 5 * 60 * 1000;

/**
 * Wait / Delay — pauses the run. Uses ctx.sleep, which the engine injects,
 * so tests record the delay instead of actually waiting. The requested
 * duration is capped at MAX_WAIT_MS.
 */
export const waitNode = defineNode({
  type: 'core.wait',
  displayName: 'Wait',
  description: 'Delays the workflow, then passes items through unchanged',
  version: 1,
  category: 'Flow Control',
  inputs: { type: 'array' },
  outputs: { type: 'array', description: 'Input items, unchanged' },
  parameters: [
    { name: 'durationMs', displayName: 'Duration (ms)', type: 'number',
      description: 'Delay in milliseconds (takes precedence over seconds)' },
    { name: 'seconds', displayName: 'Duration (seconds)', type: 'number', default: 1 },
  ],
  permissions: { network: { hosts: [] }, scopes: [], filesystem: 'none' },
  async execute(ctx, input) {
    const params = ctx.parameters;
    let requested: number;
    if (typeof params.durationMs === 'number') {
      requested = params.durationMs;
    } else if (typeof params.seconds === 'number') {
      requested = params.seconds * 1000;
    } else if (typeof params.durationMs === 'string' && params.durationMs !== '') {
      requested = Number(ctx.renderTemplate(params.durationMs, input[0]?.json));
    } else {
      requested = 1000;
    }
    if (!Number.isFinite(requested) || requested < 0) {
      throw new Error(`Wait node got an invalid duration: ${String(requested)}`);
    }
    const effective = Math.min(requested, MAX_WAIT_MS);
    if (effective > 0) await ctx.sleep(effective);
    return [input];
  },
});
