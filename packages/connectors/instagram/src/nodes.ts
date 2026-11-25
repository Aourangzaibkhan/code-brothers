import {
  defineNode,
  renderStringParam,
  type NodeContext,
  type NodeDefinition,
  type NodeItem,
  type NodeRegistry,
} from '@code-brothers/node-sdk';
import { GraphApiClient } from './graph-client.js';

const CREDENTIALS = [
  {
    name: 'instagramGraph',
    displayName: 'Instagram Graph API',
    required: true,
    fields: ['accessToken', 'igUserId', 'baseUrl'],
  },
];

const PERMISSIONS = {
  network: { hosts: ['graph.facebook.com'] },
  scopes: [
    'instagram_basic',
    'instagram_content_publish',
    'instagram_manage_comments',
    'instagram_manage_messages',
  ],
};

async function getClient(ctx: NodeContext): Promise<GraphApiClient> {
  const creds = await ctx.getCredentials('instagramGraph');
  const accessToken = typeof creds?.accessToken === 'string' ? creds.accessToken : '';
  const igUserId = typeof creds?.igUserId === 'string' ? creds.igUserId : '';
  if (!accessToken || !igUserId) {
    throw new Error('Missing instagramGraph credentials (accessToken, igUserId)');
  }
  return new GraphApiClient({
    igUserId,
    accessToken,
    // Optional override (sandbox / local mock) — omit for the real API.
    baseUrl: typeof creds?.baseUrl === 'string' && creds.baseUrl !== '' ? creds.baseUrl : undefined,
    fetch: ((url: string | URL, init?: RequestInit) => ctx.fetch(url, init)) as typeof fetch,
    sleep: (ms: number) => ctx.sleep(ms),
  });
}

function strParam(
  ctx: NodeContext,
  name: string,
  itemJson: Record<string, unknown>,
): string {
  const value = renderStringParam(ctx, name, itemJson);
  return value;
}

export const instagramPublishPost: NodeDefinition = defineNode({
  type: 'instagram.publishPost',
  displayName: 'Instagram: Publish Post',
  description: 'Create a media container, wait until it is FINISHED, and publish it on Instagram.',
  version: 1,
  category: 'Social',
  inputs: { type: 'array', items: { type: 'object' } },
  outputs: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Published media id' },
        creation_id: { type: 'string' },
      },
    },
  },
  parameters: [
    { name: 'imageUrl', displayName: 'Image URL', type: 'string', required: false },
    { name: 'videoUrl', displayName: 'Video URL', type: 'string', required: false },
    {
      name: 'mediaType',
      displayName: 'Media Type',
      type: 'options',
      required: false,
      default: 'IMAGE',
      options: [
        { name: 'Image', value: 'IMAGE' },
        { name: 'Reels', value: 'REELS' },
        { name: 'Carousel', value: 'CAROUSEL' },
      ],
    },
    { name: 'caption', displayName: 'Caption', type: 'string', required: false, default: '' },
  ],
  credentials: CREDENTIALS,
  permissions: PERMISSIONS,
  async execute(ctx, input) {
    const client = await getClient(ctx);
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const out: NodeItem[] = [];
    for (const item of items) {
      const imageUrl = strParam(ctx, 'imageUrl', item.json);
      const videoUrl = strParam(ctx, 'videoUrl', item.json);
      const mediaType = strParam(ctx, 'mediaType', item.json) || 'IMAGE';
      const caption = strParam(ctx, 'caption', item.json);
      const result = await client.publishMedia({
        ...(imageUrl ? { imageUrl } : {}),
        ...(videoUrl ? { videoUrl } : {}),
        mediaType,
        ...(caption ? { caption } : {}),
      });
      ctx.logger.info('Published Instagram media', { id: String(result.id ?? '') });
      out.push({ json: { ...item.json, ...result } });
    }
    return [out];
  },
});

export const instagramReplyComment: NodeDefinition = defineNode({
  type: 'instagram.replyComment',
  displayName: 'Instagram: Reply to Comment',
  description: 'Reply to an Instagram comment.',
  version: 1,
  category: 'Social',
  inputs: { type: 'array', items: { type: 'object' } },
  outputs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
  parameters: [
    { name: 'commentId', displayName: 'Comment ID', type: 'string', required: true },
    { name: 'message', displayName: 'Message', type: 'string', required: true },
  ],
  credentials: CREDENTIALS,
  permissions: PERMISSIONS,
  async execute(ctx, input) {
    const client = await getClient(ctx);
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const out: NodeItem[] = [];
    for (const item of items) {
      const result = await client.replyToComment(
        strParam(ctx, 'commentId', item.json),
        strParam(ctx, 'message', item.json),
      );
      out.push({ json: { ...item.json, ...result } });
    }
    return [out];
  },
});

export const instagramSendDm: NodeDefinition = defineNode({
  type: 'instagram.sendDm',
  displayName: 'Instagram: Send Direct Message',
  description: 'Send an Instagram direct message via the Graph API.',
  version: 1,
  category: 'Social',
  inputs: { type: 'array', items: { type: 'object' } },
  outputs: { type: 'array', items: { type: 'object' } },
  parameters: [
    { name: 'recipientId', displayName: 'Recipient ID', type: 'string', required: true },
    { name: 'message', displayName: 'Message', type: 'string', required: true },
  ],
  credentials: CREDENTIALS,
  permissions: PERMISSIONS,
  async execute(ctx, input) {
    const client = await getClient(ctx);
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const out: NodeItem[] = [];
    for (const item of items) {
      const result = await client.sendDirectMessage(
        strParam(ctx, 'recipientId', item.json),
        strParam(ctx, 'message', item.json),
      );
      out.push({ json: { ...item.json, ...result } });
    }
    return [out];
  },
});

export const nodes: NodeDefinition[] = [instagramPublishPost, instagramReplyComment, instagramSendDm];

export function registerInstagramNodes(registry: NodeRegistry): NodeRegistry {
  registry.registerAll(nodes);
  return registry;
}
