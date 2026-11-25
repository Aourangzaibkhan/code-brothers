import { defineNode, type NodeItem } from '@code-brothers/node-sdk';

export interface WebhookRequestData {
  method?: string;
  path?: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

/**
 * Webhook Trigger — the API layer hands the incoming HTTP request (as data)
 * to the engine as trigger data; this node validates and normalizes it into
 * a stable item shape for downstream nodes.
 *
 * Output shape: the request BODY is unwrapped to the top level of the item,
 * so a workflow reads the payload directly (`{{ $json.orderId }}`, not
 * `{{ $json.body.orderId }}`). The request metadata (method, path, headers,
 * query) is kept under `{{ $json.webhook }}`. A manual run (no request
 * envelope — the payload itself is the input) passes the payload through
 * unchanged, so manual and webhook runs behave identically.
 */
export const webhookTriggerNode = defineNode({
  type: 'core.webhookTrigger',
  displayName: 'Webhook Trigger',
  description: 'Starts the workflow from an incoming HTTP webhook request',
  version: 1,
  category: 'Triggers',
  trigger: true,
  inputs: { type: 'null', description: 'Receives the raw webhook request as run data' },
  outputs: {
    type: 'array',
    description:
      'One item: the request body unwrapped to the top level, plus a `webhook` object with { method, path, headers, query }',
  },
  parameters: [
    {
      name: 'method',
      displayName: 'HTTP Method',
      type: 'string',
      description: 'If set, requests with a different method are rejected',
    },
    {
      name: 'path',
      displayName: 'Path',
      type: 'string',
      description: 'Informational — the webhook path this trigger is bound to',
    },
  ],
  permissions: { network: { hosts: [] }, scopes: [], filesystem: 'none' },
  async execute(ctx, input) {
    const expectedMethod = ctx.parameters.method;
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const out: NodeItem[] = items.map((item) => {
      const req = item.json as WebhookRequestData;
      const method = (req.method ?? 'POST').toUpperCase();
      if (
        typeof expectedMethod === 'string' &&
        expectedMethod !== '' &&
        method !== expectedMethod.toUpperCase()
      ) {
        throw new Error(
          `Webhook method mismatch: expected ${expectedMethod.toUpperCase()}, got ${method}`,
        );
      }
      const webhook = {
        method,
        path: req.path ?? ctx.parameters.path ?? '/',
        headers: req.headers ?? {},
        query: req.query ?? {},
      };
      // Webhook request envelope: unwrap the body to the top level so
      // downstream nodes read the payload directly.
      if (req && typeof req === 'object' && 'body' in req) {
        const body = req.body;
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          return { json: { ...(body as Record<string, unknown>), webhook } };
        }
        return { json: { body, webhook } };
      }
      // Manual run: the payload itself is the input — pass it through.
      return { json: { ...(item.json as Record<string, unknown>), webhook } };
    });
    return [out];
  },
});
