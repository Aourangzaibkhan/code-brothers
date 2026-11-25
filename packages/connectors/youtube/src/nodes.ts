import {
  defineNode,
  renderStringParam,
  type NodeContext,
  type NodeDefinition,
  type NodeItem,
  type NodeRegistry,
} from '@code-brothers/node-sdk';
import { StaticAccessTokenProvider, YouTubeDataClient } from './youtube-client.js';

const CREDENTIALS = [
  {
    name: 'youtubeOAuth',
    displayName: 'YouTube OAuth',
    required: true,
    fields: ['accessToken', 'baseUrl'],
  },
];

const PERMISSIONS = {
  network: { hosts: ['www.googleapis.com', 'upload.googleapis.com'] },
  scopes: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.force-ssl',
  ],
};

async function getClient(ctx: NodeContext): Promise<YouTubeDataClient> {
  const creds = await ctx.getCredentials('youtubeOAuth');
  const accessToken = typeof creds?.accessToken === 'string' ? creds.accessToken : '';
  if (!accessToken) throw new Error('Missing youtubeOAuth credentials (accessToken)');
  return new YouTubeDataClient({
    tokenProvider: new StaticAccessTokenProvider(accessToken),
    // Optional override (sandbox / local mock) — omit for the real API.
    baseUrl: typeof creds?.baseUrl === 'string' && creds.baseUrl !== '' ? creds.baseUrl : undefined,
    fetch: ((url: string | URL, init?: RequestInit) => ctx.fetch(url, init)) as typeof fetch,
  });
}

function strParam(
  ctx: NodeContext,
  name: string,
  itemJson: Record<string, unknown>,
): string {
  return renderStringParam(ctx, name, itemJson);
}

export const youtubeUploadVideo: NodeDefinition = defineNode({
  type: 'youtube.uploadVideo',
  displayName: 'YouTube: Upload Video',
  description: 'Upload a video to YouTube using the resumable upload protocol.',
  version: 1,
  category: 'Social',
  inputs: { type: 'array', items: { type: 'object' } },
  outputs: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Created video id' },
        snippet: { type: 'object' },
        status: { type: 'object' },
      },
    },
  },
  parameters: [
    { name: 'title', displayName: 'Title', type: 'string', required: true },
    { name: 'description', displayName: 'Description', type: 'string', required: false, default: '' },
    {
      name: 'privacyStatus',
      displayName: 'Privacy Status',
      type: 'options',
      required: false,
      default: 'private',
      options: [
        { name: 'Private', value: 'private' },
        { name: 'Public', value: 'public' },
        { name: 'Unlisted', value: 'unlisted' },
      ],
    },
    { name: 'tags', displayName: 'Tags (comma separated)', type: 'string', required: false, default: '' },
    { name: 'categoryId', displayName: 'Category ID', type: 'string', required: false },
    { name: 'contentBase64', displayName: 'Video Content (Base64)', type: 'string', required: true },
    { name: 'contentType', displayName: 'Content Type', type: 'string', required: false, default: 'video/mp4' },
  ],
  credentials: CREDENTIALS,
  permissions: PERMISSIONS,
  async execute(ctx, input) {
    const client = await getClient(ctx);
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const out: NodeItem[] = [];
    for (const item of items) {
      const contentBase64 = strParam(ctx, 'contentBase64', item.json);
      if (!contentBase64) throw new Error('youtube.uploadVideo requires the contentBase64 parameter');
      const bytes = new Uint8Array(Buffer.from(contentBase64, 'base64'));
      const tagsRaw = strParam(ctx, 'tags', item.json);
      const tags = tagsRaw
        ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
        : undefined;
      const categoryId = strParam(ctx, 'categoryId', item.json);
      const video = await client.uploadVideo({
        title: strParam(ctx, 'title', item.json),
        description: strParam(ctx, 'description', item.json) || undefined,
        privacyStatus: strParam(ctx, 'privacyStatus', item.json) || 'private',
        tags,
        ...(categoryId ? { categoryId } : {}),
        contentType: strParam(ctx, 'contentType', item.json) || 'video/mp4',
        bytes,
      });
      ctx.logger.info('Uploaded YouTube video', { id: String(video.id ?? '') });
      out.push({ json: { ...item.json, ...video } });
    }
    return [out];
  },
});

export const youtubeReplyComment: NodeDefinition = defineNode({
  type: 'youtube.replyComment',
  displayName: 'YouTube: Reply to Comment',
  description: 'Reply to a YouTube comment.',
  version: 1,
  category: 'Social',
  inputs: { type: 'array', items: { type: 'object' } },
  outputs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
  parameters: [
    { name: 'commentId', displayName: 'Parent Comment ID', type: 'string', required: true },
    { name: 'text', displayName: 'Text', type: 'string', required: true },
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
        strParam(ctx, 'text', item.json),
      );
      out.push({ json: { ...item.json, ...result } });
    }
    return [out];
  },
});

export const nodes: NodeDefinition[] = [youtubeUploadVideo, youtubeReplyComment];

export function registerYoutubeNodes(registry: NodeRegistry): NodeRegistry {
  registry.registerAll(nodes);
  return registry;
}
