import { defineNode, type NodeItem } from '@code-brothers/node-sdk';

/**
 * HTTP Request — calls ctx.fetch, which the engine wraps with the SSRF
 * guard, so this node can never reach private/loopback targets unless the
 * deployment explicitly configured a permissive guard.
 */
export const httpRequestNode = defineNode({
  type: 'core.httpRequest',
  displayName: 'HTTP Request',
  description: 'Makes an SSRF-guarded HTTP request per input item',
  version: 1,
  category: 'HTTP',
  inputs: { type: 'array', description: 'Items used to render the URL/body templates' },
  outputs: {
    type: 'array',
    description: 'Items with { statusCode, headers, body }',
  },
  parameters: [
    { name: 'method', displayName: 'Method', type: 'options', default: 'GET',
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ name: m, value: m })) },
    { name: 'url', displayName: 'URL', type: 'string', required: true,
      description: 'May contain {{ expressions }} rendered per item' },
    { name: 'headers', displayName: 'Headers', type: 'json',
      description: 'Object of header name -> value (values may be templates)' },
    { name: 'body', displayName: 'Body', type: 'json',
      description: 'Request body: string template, or object sent as JSON' },
    { name: 'responseType', displayName: 'Response Type', type: 'options', default: 'json',
      options: [{ name: 'JSON', value: 'json' }, { name: 'Text', value: 'text' }] },
    { name: 'ignoreHttpErrors', displayName: 'Ignore HTTP Errors', type: 'boolean', default: false },
  ],
  permissions: {
    network: { hosts: ['*'] },
    scopes: [],
    filesystem: 'none',
    description: 'Outbound HTTP is always passed through the SSRF guard',
  },
  async execute(ctx, input) {
    const params = ctx.parameters;
    const method = String(params.method ?? 'GET').toUpperCase();
    const urlTemplate = params.url;
    if (typeof urlTemplate !== 'string' || urlTemplate === '') {
      throw new Error('HTTP Request node requires a "url" parameter');
    }
    const responseType = params.responseType === 'text' ? 'text' : 'json';
    const ignoreHttpErrors = params.ignoreHttpErrors === true;
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];

    const out: NodeItem[] = [];
    for (const [index, item] of items.entries()) {
      const url = String(ctx.renderTemplate(urlTemplate, item.json));
      const headers: Record<string, string> = {};
      if (params.headers && typeof params.headers === 'object') {
        for (const [key, value] of Object.entries(
          params.headers as Record<string, unknown>,
        )) {
          headers[key] = String(ctx.renderTemplate(value, item.json) ?? '');
        }
      }
      let body: string | undefined;
      if (params.body !== undefined && params.body !== null) {
        if (typeof params.body === 'string') {
          body = String(ctx.renderTemplate(params.body, item.json) ?? '');
        } else {
          body = JSON.stringify(params.body);
          if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
            headers['content-type'] = 'application/json';
          }
        }
      }

      const response = await ctx.fetch(url, { method, headers, body });
      const text = await response.text();
      let parsedBody: unknown = text;
      if (responseType === 'json' && text !== '') {
        try {
          parsedBody = JSON.parse(text) as unknown;
        } catch {
          parsedBody = text;
        }
      }
      if (!response.ok && !ignoreHttpErrors) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText} from ${method} ${url}`,
        );
      }
      out.push({
        json: {
          statusCode: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: parsedBody,
        },
        pairedItem: index,
      });
    }
    return [out];
  },
});
