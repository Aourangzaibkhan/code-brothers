import {
  defineNode,
  type NodeContext,
  type NodeDefinition,
  type NodeInputData,
  type NodeOutputData,
  type NodeRegistry,
} from '@code-brothers/node-sdk';
import { CloudApiClient, type TemplateComponent } from './cloud-client.js';

const CREDENTIALS = [
  {
    name: 'whatsappCloud',
    displayName: 'WhatsApp Cloud API',
    required: true,
    fields: ['phoneNumberId', 'accessToken'],
  },
];

async function buildClient(ctx: NodeContext): Promise<CloudApiClient> {
  const creds = await ctx.getCredentials('whatsappCloud');
  if (!creds?.['phoneNumberId'] || !creds?.['accessToken']) {
    throw new Error(
      'WhatsApp node requires the "whatsappCloud" credential (phoneNumberId + accessToken)',
    );
  }
  return new CloudApiClient({
    phoneNumberId: String(creds['phoneNumberId']),
    accessToken: String(creds['accessToken']),
    fetch: ctx.fetch,
    apiVersion:
      typeof creds['apiVersion'] === 'string' ? creds['apiVersion'] : undefined,
    baseUrl: typeof creds['baseUrl'] === 'string' ? creds['baseUrl'] : undefined,
  });
}

/** Run `fn` once per input item (or once when there is no input). */
async function perItem(
  input: NodeInputData,
  fn: (itemJson: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<NodeOutputData> {
  const items = input.length > 0 ? input : [{ json: {} }];
  const out = [];
  for (const item of items) out.push({ json: await fn(item.json) });
  return [out];
}

function param(
  ctx: NodeContext,
  itemJson: Record<string, unknown>,
  name: string,
): unknown {
  return itemJson[name] ?? ctx.parameters[name];
}

export const whatsappSendMessageNode: NodeDefinition = defineNode({
  type: 'whatsapp.sendMessage',
  displayName: 'WhatsApp: Send Message',
  description:
    'Send a text message via the WhatsApp Cloud API. Per-item "to"/"body" fields override the node parameters.',
  version: 1,
  category: 'Messaging',
  inputs: { type: 'object' },
  outputs: {
    type: 'object',
    properties: {
      messageId: { type: 'string' },
      to: { type: 'string' },
      status: { type: 'string' },
    },
  },
  parameters: [
    { name: 'to', displayName: 'To (phone, intl format)', type: 'string', required: true },
    { name: 'body', displayName: 'Message body', type: 'string', required: true },
  ],
  credentials: CREDENTIALS,
  permissions: {
    network: { hosts: ['graph.facebook.com'] },
    scopes: ['whatsapp_business_messaging'],
  },
  async execute(ctx, input) {
    const client = await buildClient(ctx);
    return perItem(input, async (itemJson) => {
      const to = String(param(ctx, itemJson, 'to') ?? '');
      const body = String(param(ctx, itemJson, 'body') ?? '');
      if (!to || !body) throw new Error('WhatsApp send requires "to" and "body"');
      const result = await client.sendText(to, body);
      return { messageId: result.messageId, to: result.to, status: 'sent' };
    });
  },
});

export const whatsappSendTemplateNode: NodeDefinition = defineNode({
  type: 'whatsapp.sendTemplate',
  displayName: 'WhatsApp: Send Template',
  description:
    'Send an approved WhatsApp template message via the Cloud API (works outside the 24h customer window).',
  version: 1,
  category: 'Messaging',
  inputs: { type: 'object' },
  outputs: {
    type: 'object',
    properties: {
      messageId: { type: 'string' },
      to: { type: 'string' },
      status: { type: 'string' },
    },
  },
  parameters: [
    { name: 'to', displayName: 'To (phone, intl format)', type: 'string', required: true },
    { name: 'templateName', displayName: 'Template name', type: 'string', required: true },
    {
      name: 'languageCode',
      displayName: 'Language code',
      type: 'string',
      default: 'en_US',
    },
    {
      name: 'componentsJson',
      displayName: 'Components (JSON array)',
      type: 'json',
    },
  ],
  credentials: CREDENTIALS,
  permissions: {
    network: { hosts: ['graph.facebook.com'] },
    scopes: ['whatsapp_business_messaging'],
  },
  async execute(ctx, input) {
    const client = await buildClient(ctx);
    return perItem(input, async (itemJson) => {
      const to = String(param(ctx, itemJson, 'to') ?? '');
      const templateName = String(param(ctx, itemJson, 'templateName') ?? '');
      const languageCode = String(
        param(ctx, itemJson, 'languageCode') ?? 'en_US',
      );
      const rawComponents = param(ctx, itemJson, 'componentsJson');
      const components =
        typeof rawComponents === 'string' && rawComponents
          ? (JSON.parse(rawComponents) as TemplateComponent[])
          : (rawComponents as TemplateComponent[] | undefined);
      if (!to || !templateName) {
        throw new Error('WhatsApp template send requires "to" and "templateName"');
      }
      const result = await client.sendTemplate(to, templateName, languageCode, components);
      return { messageId: result.messageId, to: result.to, status: 'sent' };
    });
  },
});

export const whatsappNodes: NodeDefinition[] = [
  whatsappSendMessageNode,
  whatsappSendTemplateNode,
];

export function registerWhatsAppNodes(registry: NodeRegistry): NodeRegistry {
  registry.registerAll(whatsappNodes);
  return registry;
}
