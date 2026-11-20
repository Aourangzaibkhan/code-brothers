/**
 * Node type catalog for the canvas palette + property panel.
 * Type ids and parameter names mirror the real node definitions in
 * @code-brothers/core (packages/core/src/nodes) and the connector packages
 * (packages/connectors/*) so graphs saved from this UI run in the engine.
 */

export type ParamType = 'string' | 'number' | 'boolean' | 'json' | 'options';

export interface ParamDef {
  name: string;
  label: string;
  type: ParamType;
  default?: unknown;
  options?: string[];
  required?: boolean;
  placeholder?: string;
}

export interface NodeTypeDef {
  type: string;
  label: string;
  category: 'trigger' | 'core' | 'connector';
  /** Number of output branches (IF = 2: true/false). Switch is dynamic; edges store the branch index. */
  outputs: number;
  params: ParamDef[];
}

const s = (name: string, label: string, extra: Partial<ParamDef> = {}): ParamDef => ({ name, label, type: 'string', ...extra });
const n = (name: string, label: string, extra: Partial<ParamDef> = {}): ParamDef => ({ name, label, type: 'number', ...extra });
const b = (name: string, label: string, extra: Partial<ParamDef> = {}): ParamDef => ({ name, label, type: 'boolean', ...extra });
const j = (name: string, label: string, extra: Partial<ParamDef> = {}): ParamDef => ({ name, label, type: 'json', ...extra });
const o = (name: string, label: string, options: string[], extra: Partial<ParamDef> = {}): ParamDef => ({ name, label, type: 'options', options, ...extra });

export const NODE_CATALOG: NodeTypeDef[] = [
  // -- triggers -------------------------------------------------------------
  { type: 'core.manualTrigger', label: 'Manual Trigger', category: 'trigger', outputs: 1, params: [j('payload', 'Payload (JSON)')] },
  {
    type: 'core.webhookTrigger', label: 'Webhook Trigger', category: 'trigger', outputs: 1,
    params: [o('method', 'Method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], { default: 'POST' }), s('path', 'Path', { placeholder: '/hooks/my-flow' })],
  },
  {
    type: 'core.cronTrigger', label: 'Cron Trigger', category: 'trigger', outputs: 1,
    params: [s('expression', 'Cron expression', { default: '0 * * * *', required: true })],
  },
  // -- core -------------------------------------------------------------------
  {
    type: 'core.httpRequest', label: 'HTTP Request', category: 'core', outputs: 1,
    params: [
      o('method', 'Method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], { default: 'GET' }),
      s('url', 'URL', { required: true, placeholder: 'https://example.com/api' }),
      j('headers', 'Headers (JSON)'),
      j('body', 'Body (JSON)'),
      o('responseType', 'Response type', ['json', 'text'], { default: 'json' }),
      b('ignoreHttpErrors', 'Ignore HTTP errors', { default: false }),
    ],
  },
  {
    type: 'core.if', label: 'IF', category: 'core', outputs: 2,
    params: [
      s('left', 'Value 1', { required: true, placeholder: '{{ $json.total }}' }),
      o('operator', 'Operator', ['equals', 'notEquals', 'contains', 'gt', 'lt', 'exists'], { default: 'equals' }),
      j('right', 'Value 2 (JSON)'),
    ],
  },
  {
    type: 'core.switch', label: 'Switch', category: 'core', outputs: 2,
    params: [s('value', 'Value', { required: true }), j('cases', 'Cases (JSON array)', { required: true, placeholder: '[{"value":"a"},{"value":"b"}]' })],
  },
  { type: 'core.loop', label: 'Loop', category: 'core', outputs: 1, params: [s('arrayField', 'Array field', { default: 'items' })] },
  { type: 'core.wait', label: 'Wait', category: 'core', outputs: 1, params: [n('seconds', 'Duration (seconds)', { default: 1 })] },
  {
    type: 'core.setData', label: 'Set Data', category: 'core', outputs: 1,
    params: [j('fields', 'Fields (JSON)', { placeholder: '{"status":"done"}' }), b('keepOnlySet', 'Keep only set fields', { default: false })],
  },
  {
    type: 'core.log', label: 'Log', category: 'core', outputs: 1,
    params: [s('message', 'Message'), o('level', 'Level', ['info', 'warn', 'error'], { default: 'info' })],
  },
  { type: 'core.noop', label: 'No Operation', category: 'core', outputs: 1, params: [] },
  // -- connectors ---------------------------------------------------------------
  {
    type: 'whatsapp.sendMessage', label: 'WhatsApp: Send Message', category: 'connector', outputs: 1,
    params: [s('to', 'To (phone, intl format)', { required: true, placeholder: '923001234567' }), s('body', 'Message body', { required: true })],
  },
  {
    type: 'whatsapp.sendTemplate', label: 'WhatsApp: Send Template', category: 'connector', outputs: 1,
    params: [s('to', 'To (phone, intl format)', { required: true }), s('templateName', 'Template name', { required: true }), s('languageCode', 'Language code', { default: 'en' }), j('componentsJson', 'Components (JSON)')],
  },
  {
    type: 'instagram.publishPost', label: 'Instagram: Publish Post', category: 'connector', outputs: 1,
    params: [o('mediaType', 'Media type', ['IMAGE', 'REELS', 'CAROUSEL'], { default: 'IMAGE' }), s('imageUrl', 'Image URL'), s('videoUrl', 'Video URL'), s('caption', 'Caption')],
  },
  {
    type: 'instagram.sendDm', label: 'Instagram: Send DM', category: 'connector', outputs: 1,
    params: [s('recipientId', 'Recipient ID', { required: true }), s('message', 'Message', { required: true })],
  },
  {
    type: 'instagram.replyComment', label: 'Instagram: Reply Comment', category: 'connector', outputs: 1,
    params: [s('commentId', 'Comment ID', { required: true }), s('message', 'Message', { required: true })],
  },
  {
    type: 'youtube.uploadVideo', label: 'YouTube: Upload Video', category: 'connector', outputs: 1,
    params: [s('title', 'Title', { required: true }), s('description', 'Description'), o('privacyStatus', 'Privacy', ['private', 'public', 'unlisted'], { default: 'private' }), s('tags', 'Tags (comma separated)'), s('categoryId', 'Category ID'), s('contentBase64', 'Video content (Base64)', { required: true })],
  },
  {
    type: 'youtube.replyComment', label: 'YouTube: Reply Comment', category: 'connector', outputs: 1,
    params: [s('commentId', 'Parent comment ID', { required: true }), s('text', 'Text', { required: true })],
  },
  {
    type: 'shopify.getOrders', label: 'Shopify: Get Orders', category: 'connector', outputs: 1,
    params: [o('status', 'Status', ['any', 'open', 'closed', 'cancelled'], { default: 'any' }), n('limit', 'Limit', { default: 50 })],
  },
  {
    type: 'shopify.createDraftOrder', label: 'Shopify: Create Draft Order', category: 'connector', outputs: 1,
    params: [s('email', 'Customer email'), j('lineItemsJson', 'Line items (JSON)')],
  },
  {
    type: 'shopify.updateInventory', label: 'Shopify: Update Inventory', category: 'connector', outputs: 1,
    params: [s('locationId', 'Location ID', { required: true }), s('inventoryItemId', 'Inventory item ID', { required: true }), n('available', 'Available', { required: true })],
  },
  {
    type: 'daraz.getOrders', label: 'Daraz: Get Orders', category: 'connector', outputs: 1,
    params: [s('createdAfter', 'Created after (ISO)'), s('status', 'Status'), n('limit', 'Limit', { default: 50 })],
  },
  {
    type: 'daraz.updateStock', label: 'Daraz: Update Stock', category: 'connector', outputs: 1,
    params: [s('sellerSku', 'Seller SKU', { required: true }), n('quantity', 'Quantity', { required: true })],
  },
  {
    type: 'local.dbQuery', label: 'Local: DB Query', category: 'connector', outputs: 1,
    params: [s('sql', 'SQL (parameterized)', { required: true }), j('valuesJson', 'Values (JSON)')],
  },
  {
    type: 'local.sendWebhook', label: 'Local: Send Webhook', category: 'connector', outputs: 1,
    params: [s('url', 'URL', { required: true }), s('event', 'Event', { required: true, default: 'order.created' })],
  },
  {
    type: 'local.wooGetOrders', label: 'Local: WooCommerce Orders', category: 'connector', outputs: 1,
    params: [o('status', 'Status', ['any', 'pending', 'processing', 'completed', 'cancelled', 'refunded'], { default: 'any' }), n('perPage', 'Per page', { default: 10 })],
  },
  {
    type: 'courier.bookShipment', label: 'Courier: Book Shipment', category: 'connector', outputs: 1,
    params: [
      s('preset', 'Preset'), s('receiverName', 'Receiver name', { required: true }), s('receiverPhone', 'Receiver phone', { required: true }),
      s('receiverAddress', 'Receiver address', { required: true }), s('receiverCity', 'Receiver city', { required: true }),
      s('receiverCountry', 'Receiver country', { required: true }), n('weightKg', 'Weight (kg)', { default: 1 }),
      n('pieces', 'Pieces', { default: 1 }), n('codAmount', 'COD amount'), s('currency', 'Currency'),
    ],
  },
  {
    type: 'courier.track', label: 'Courier: Track', category: 'connector', outputs: 1,
    params: [s('preset', 'Preset'), s('awb', 'AWB / Tracking number', { required: true })],
  },
  {
    type: 'core.emailSend', label: 'Email: Send', category: 'connector', outputs: 1,
    params: [s('from', 'From', { required: true }), s('to', 'To', { required: true }), s('subject', 'Subject', { required: true }), s('text', 'Text body'), s('html', 'HTML body')],
  },
  {
    type: 'core.pdfGenerate', label: 'PDF: Generate', category: 'connector', outputs: 1,
    params: [s('title', 'Title'), s('text', 'Text')],
  },
  {
    type: 'core.googleSheetsAppend', label: 'Google Sheets: Append', category: 'connector', outputs: 1,
    params: [s('spreadsheetId', 'Spreadsheet ID', { required: true }), s('range', 'Range', { required: true, default: 'Sheet1!A1' }), j('valuesJson', 'Values (JSON)')],
  },
  {
    type: 'core.csvTransform', label: 'CSV: Transform', category: 'connector', outputs: 1,
    params: [j('columnMappingJson', 'Column mapping (JSON)')],
  },
];

export const NODE_TYPE_MAP: ReadonlyMap<string, NodeTypeDef> = new Map(
  NODE_CATALOG.map((def) => [def.type, def]),
);

export function defaultParameters(def: NodeTypeDef): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const p of def.params) {
    if (p.default !== undefined) params[p.name] = p.default;
  }
  return params;
}

let counter = 0;
export function newNodeId(type: string): string {
  counter += 1;
  const short = type.replace(/[^a-zA-Z0-9]/g, '-');
  return `${short}-${Date.now().toString(36)}-${counter}`;
}
