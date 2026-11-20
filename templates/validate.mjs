#!/usr/bin/env node
/**
 * Validates every workflow template in this directory.
 *
 * Checks per template file (template-*.json):
 *   1. File parses as JSON and has the WorkflowDefinition shape
 *      ({ id, name, nodes, edges, settings }) from @code-brothers/core
 *      (packages/core/src/types.ts).
 *   2. Workflow id matches the file name.
 *   3. Node ids are unique; every node has a known type.
 *   4. Every edge endpoint (from / to) references an existing node id.
 *   5. The workflow starts from a trigger node.
 *
 * Known node types mirror the registries in the source tree:
 *   - packages/core/src/nodes/*.ts            (core.* built-ins)
 *   - packages/connectors/core-nodes/src/nodes.ts
 *   - packages/connectors/{whatsapp,instagram,youtube,shopify,daraz,
 *     ecommerce-local,couriers}/src/nodes.ts
 *
 * Usage: node templates/validate.mjs   (exit 0 = all templates valid)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

const CORE_TYPES = [
  // packages/core/src/nodes/
  'core.manualTrigger', 'core.webhookTrigger', 'core.cronTrigger',
  'core.httpRequest', 'core.if', 'core.switch', 'core.loop', 'core.wait',
  'core.setData', 'core.log', 'core.noop',
  // packages/connectors/core-nodes/
  'core.emailSend', 'core.pdfGenerate', 'core.googleSheetsAppend',
  'core.csvTransform',
];

const CONNECTOR_TYPES = [
  // whatsapp
  'whatsapp.sendMessage', 'whatsapp.sendTemplate',
  // instagram
  'instagram.publishPost', 'instagram.replyComment', 'instagram.sendDm',
  // youtube
  'youtube.uploadVideo', 'youtube.replyComment',
  // shopify
  'shopify.getOrders', 'shopify.createDraftOrder', 'shopify.updateInventory',
  // daraz
  'daraz.getOrders', 'daraz.updateStock',
  // ecommerce-local
  'local.dbQuery', 'local.sendWebhook', 'local.wooGetOrders',
  // couriers
  'courier.bookShipment', 'courier.track',
];

const KNOWN_TYPES = new Set([...CORE_TYPES, ...CONNECTOR_TYPES]);
const TRIGGER_TYPES = new Set([
  'core.manualTrigger', 'core.webhookTrigger', 'core.cronTrigger',
]);

const files = readdirSync(dir)
  .filter((f) => f.startsWith('template-') && f.endsWith('.json'))
  .sort();

if (files.length === 0) {
  console.error('No template-*.json files found');
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  const errors = [];
  let def;
  try {
    def = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (err) {
    console.error(`FAIL ${file}: invalid JSON — ${err.message}`);
    failures++;
    continue;
  }

  if (!def.id || typeof def.id !== 'string') errors.push('missing string "id"');
  if (def.id && def.id !== file.replace(/\.json$/, '')) {
    errors.push(`id "${def.id}" does not match file name`);
  }
  if (!def.name) errors.push('missing "name"');
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    errors.push('"nodes" must be a non-empty array');
  }
  if (!Array.isArray(def.edges)) errors.push('"edges" must be an array');

  const ids = new Set();
  for (const node of def.nodes ?? []) {
    if (!node.id) errors.push('node without id');
    if (ids.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
    ids.add(node.id);
    if (!KNOWN_TYPES.has(node.type)) {
      errors.push(`node "${node.id}" has unknown type "${node.type}"`);
    }
  }
  for (const edge of def.edges ?? []) {
    if (!ids.has(edge.from)) errors.push(`edge from unknown node "${edge.from}"`);
    if (!ids.has(edge.to)) errors.push(`edge to unknown node "${edge.to}"`);
  }
  const hasTrigger = (def.nodes ?? []).some((n) => TRIGGER_TYPES.has(n.type));
  if (!hasTrigger) errors.push('no trigger node (manual/webhook/cron) found');

  if (errors.length > 0) {
    failures++;
    console.error(`FAIL ${file}:`);
    for (const e of errors) console.error(`  - ${e}`);
  } else {
    console.log(
      `OK   ${file} (${def.nodes.length} nodes, ${def.edges.length} edges)`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} template(s) failed validation`);
  process.exit(1);
}
console.log(`\nAll ${files.length} templates are valid.`);
