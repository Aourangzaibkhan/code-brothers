import {
  defineNode,
  renderParams,
  renderStringParam,
  renderValue,
  NodeRegistry,
  type NodeDefinition,
  type NodeItem,
} from '@code-brothers/node-sdk';
import { createEmailSender, type EmailTransportOptions } from './email.js';
import { generateTextPdf } from './pdf.js';
import { GoogleSheetsClient } from './sheets.js';
import { parseCsv, rowsToObjects } from './csv.js';

/**
 * Send an email via SMTP credentials.
 *
 * Test hook: when `ctx.variables.mailTransport` is set it is used verbatim
 * as the nodemailer transport (e.g. `{ jsonTransport: true }`), bypassing
 * the `smtp` credential entirely.
 */
export const emailSendNode = defineNode({
  type: 'core.emailSend',
  displayName: 'Email Send',
  description: 'Sends an email through the configured SMTP credential',
  version: 1,
  category: 'Utilities',
  inputs: { type: 'array', description: 'Input items (ignored except as trigger)' },
  outputs: {
    type: 'array',
    description: 'One item with { messageId, from, to, subject, raw? }',
  },
  parameters: [
    { name: 'from', displayName: 'From', type: 'string', required: true },
    { name: 'to', displayName: 'To', type: 'string', required: true },
    { name: 'subject', displayName: 'Subject', type: 'string', required: true },
    { name: 'text', displayName: 'Text Body', type: 'string' },
    { name: 'html', displayName: 'HTML Body', type: 'string' },
  ],
  credentials: [
    {
      name: 'smtp',
      displayName: 'SMTP',
      required: false,
      fields: ['host', 'port', 'user', 'pass', 'secure'],
    },
  ],
  permissions: {
    network: { hosts: ['*'] },
    scopes: ['email:send'],
    filesystem: 'none',
  },
  async execute(ctx, input) {
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const out: NodeItem[] = [];
    for (const item of items) {
      const params = renderParams(ctx, item.json);
      const from = params.from;
      const to = params.to;
      const subject = params.subject;
      if (typeof from !== 'string' || typeof to !== 'string' || typeof subject !== 'string') {
        throw new Error('Email Send node requires "from", "to" and "subject" parameters');
      }
      const text = typeof params.text === 'string' ? params.text : undefined;
      const html = typeof params.html === 'string' ? params.html : undefined;

      const mailTransport = ctx.variables.mailTransport;
      let sender;
      if (mailTransport !== undefined) {
        // Documented test hook — see the node description above.
        sender = createEmailSender({
          transport: mailTransport as EmailTransportOptions,
        });
      } else {
        const credentials = await ctx.getCredentials('smtp');
        if (credentials && typeof credentials.host === 'string') {
          sender = createEmailSender({
            transport: {
              host: credentials.host,
              port:
                typeof credentials.port === 'number'
                  ? credentials.port
                  : Number(credentials.port ?? 587),
              secure: credentials.secure === true || credentials.secure === 'true',
              auth:
                typeof credentials.user === 'string'
                  ? {
                      user: credentials.user,
                      pass:
                        typeof credentials.pass === 'string' ? credentials.pass : '',
                    }
                  : undefined,
            },
          });
        } else {
          // No SMTP configured: fall back to nodemailer's JSON transport so the
          // node still produces a verifiable message record in dev/test.
          sender = createEmailSender({ transport: { jsonTransport: true } });
        }
      }

      const result = await sender.send({ from, to, subject, text, html });
      out.push({
        json: {
          ...item.json,
          messageId: result.messageId,
          from,
          to,
          subject,
          ...(result.raw !== undefined ? { raw: result.raw } : {}),
        },
      });
    }
    return [out];
  },
});

/** Generate a simple PDF document from text and emit it as base64. */
export const pdfGenerateNode = defineNode({
  type: 'core.pdfGenerate',
  displayName: 'PDF Generate',
  description: 'Renders title + text lines into a PDF, output as base64',
  version: 1,
  category: 'Utilities',
  inputs: { type: 'array', description: 'Input items (ignored except as trigger)' },
  outputs: {
    type: 'array',
    description: 'One item with { filename, mimeType, base64 }',
  },
  parameters: [
    { name: 'title', displayName: 'Title', type: 'string' },
    {
      name: 'text',
      displayName: 'Text',
      type: 'string',
      required: true,
      description: 'Body text; split into lines on newlines',
    },
  ],
  permissions: {
    network: { hosts: [] },
    scopes: [],
    filesystem: 'none',
  },
  async execute(ctx, input) {
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const out: NodeItem[] = [];
    for (const item of items) {
      const text = renderStringParam(ctx, 'text', item.json);
      if (text === '') {
        throw new Error('PDF Generate node requires a "text" parameter');
      }
      const title = renderStringParam(ctx, 'title', item.json) || undefined;
      const pdf = await generateTextPdf({
        title,
        lines: text.split(/\r?\n/),
      });
      out.push({
        json: {
          ...item.json,
          filename: 'document.pdf',
          mimeType: 'application/pdf',
          base64: pdf.toString('base64'),
        },
      });
    }
    return [out];
  },
});

/** Append rows to a Google Sheet. */
export const googleSheetsAppendNode = defineNode({
  type: 'core.googleSheetsAppend',
  displayName: 'Google Sheets Append',
  description: 'Appends rows of values to a Google Sheets range',
  version: 1,
  category: 'Utilities',
  inputs: { type: 'array', description: 'Input items (ignored except as trigger)' },
  outputs: {
    type: 'array',
    description: 'One item with the Sheets API append response',
  },
  parameters: [
    { name: 'spreadsheetId', displayName: 'Spreadsheet ID', type: 'string', required: true },
    { name: 'range', displayName: 'Range', type: 'string', required: true, default: 'Sheet1!A1' },
    {
      name: 'valuesJson',
      displayName: 'Values (JSON array of arrays)',
      type: 'string',
      required: true,
    },
  ],
  credentials: [
    {
      name: 'googleSheets',
      displayName: 'Google Sheets',
      required: true,
      fields: ['accessToken'],
    },
  ],
  permissions: {
    network: { hosts: ['sheets.googleapis.com'] },
    scopes: ['spreadsheets:append'],
    filesystem: 'none',
  },
  async execute(ctx, input) {
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    const out: NodeItem[] = [];
    for (const item of items) {
      const params = renderParams(ctx, item.json);
      const spreadsheetId = params.spreadsheetId;
      const range = params.range;
      if (typeof spreadsheetId !== 'string' || typeof range !== 'string') {
        throw new Error(
          'Google Sheets Append node requires "spreadsheetId" and "range" parameters',
        );
      }
      const valuesRaw = params.valuesJson;
      let values: unknown[][];
      if (typeof valuesRaw === 'string') {
        const parsed = JSON.parse(valuesRaw) as unknown;
        if (!Array.isArray(parsed)) {
          throw new Error('"valuesJson" must be a JSON array of arrays');
        }
        values = parsed as unknown[][];
      } else if (Array.isArray(valuesRaw)) {
        values = valuesRaw as unknown[][];
      } else {
        throw new Error('"valuesJson" must be a JSON array of arrays');
      }
      const credentials = await ctx.getCredentials('googleSheets');
      const accessToken = credentials?.accessToken;
      if (typeof accessToken !== 'string' || accessToken === '') {
        throw new Error(
          'Google Sheets Append node requires the googleSheets credential field "accessToken"',
        );
      }
      const client = new GoogleSheetsClient({
        spreadsheetId,
        accessToken,
        fetch: ctx.fetch as typeof fetch,
      });
      const result = await client.appendValues(range, values);
      const json =
        result && typeof result === 'object'
          ? (result as Record<string, unknown>)
          : { result };
      out.push({ json: { ...item.json, ...json, spreadsheetId, range } });
    }
    return [out];
  },
});

/**
 * Transform CSV text carried on input items (`item.json.csv`) into one item
 * per data row, optionally renaming columns via `columnMappingJson`
 * (a JSON object of oldName -> newName).
 */
export const csvTransformNode = defineNode({
  type: 'core.csvTransform',
  displayName: 'CSV Transform',
  description: 'Parses CSV from each input item into row objects, with optional column renames',
  version: 1,
  category: 'Utilities',
  inputs: {
    type: 'array',
    description: 'Items with a string `csv` field in their JSON',
  },
  outputs: {
    type: 'array',
    description: 'One item per CSV data row (header row becomes the keys)',
  },
  parameters: [
    {
      name: 'columnMappingJson',
      displayName: 'Column Mapping (JSON object)',
      type: 'string',
      description: 'Optional JSON object mapping old column names to new names',
    },
  ],
  permissions: {
    network: { hosts: [] },
    scopes: [],
    filesystem: 'none',
  },
  async execute(ctx, input) {
    const items: NodeItem[] = input.length > 0 ? input : [{ json: {} }];
    let mapping: Record<string, string> = {};
    const mappingRaw = renderValue(
      ctx,
      ctx.parameters.columnMappingJson,
      items[0]?.json ?? {},
    );
    if (typeof mappingRaw === 'string' && mappingRaw.trim() !== '') {
      const parsed = JSON.parse(mappingRaw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('"columnMappingJson" must be a JSON object of oldName -> newName');
      }
      mapping = parsed as Record<string, string>;
    } else if (mappingRaw && typeof mappingRaw === 'object' && !Array.isArray(mappingRaw)) {
      mapping = mappingRaw as Record<string, string>;
    }

    const out = [];
    for (const item of input) {
      const csv = item.json.csv;
      if (typeof csv !== 'string') {
        throw new Error('CSV Transform node expects each input item to carry a string "csv" field');
      }
      const objects = rowsToObjects(parseCsv(csv));
      for (const obj of objects) {
        const renamed: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
          renamed[mapping[key] ?? key] = value;
        }
        out.push({ json: renamed });
      }
    }
    return [out];
  },
});

/** All core utility node definitions shipped by this package. */
export const nodes: NodeDefinition[] = [
  emailSendNode,
  pdfGenerateNode,
  googleSheetsAppendNode,
  csvTransformNode,
];

/** Register all core utility nodes on a registry. */
export function registerCoreUtilityNodes(registry: NodeRegistry): NodeRegistry {
  return registry.registerAll(nodes);
}
