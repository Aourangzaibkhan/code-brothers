import type { WorkflowEdge, WorkflowNodeInstance } from '../api/types';
import { NODE_TYPE_MAP, defaultParameters } from './nodeCatalog';

/**
 * Local Copilot (spec §4A). The Fastify API has no AI chat endpoint yet, so
 * the dashboard ships a deterministic prompt-to-workflow generator: it maps
 * trigger/action keywords in the user's description to real node types and
 * returns a valid engine graph the canvas can insert and run. When an
 * `/api/assistant/chat` endpoint lands, the drawer can swap this module for
 * an API call behind the same interface.
 */
export interface GeneratedWorkflow {
  name: string;
  nodes: WorkflowNodeInstance[];
  edges: WorkflowEdge[];
}

interface ActionMatch {
  type: string;
  params?: Record<string, unknown>;
  index: number;
}

function findActions(text: string): ActionMatch[] {
  const matches: ActionMatch[] = [];
  const add = (pattern: RegExp, type: string, params?: Record<string, unknown>) => {
    const m = pattern.exec(text);
    if (m) matches.push({ type, params, index: m.index });
  };

  add(/\bwhats\s?app\b/, 'whatsapp.sendMessage', { body: 'Hello! Your order has been received.' });
  add(/\btemplate\b/, 'whatsapp.sendTemplate', { templateName: 'order_update' });
  add(/\be-?mail\b/, 'core.emailSend', { subject: 'Notification' });
  add(/\bhttp\b|\bapi call\b|\bwebhook call\b/, 'core.httpRequest', { method: 'GET' });
  add(/\bshopify\b/, 'shopify.getOrders');
  add(/\bdaraz\b/, 'daraz.getOrders');
  add(/\bstock\b|\binventory\b/, 'daraz.updateStock');
  add(/\binstagram\b|\bdm\b/, 'instagram.sendDm');
  add(/\bpost\b.*\binstagram\b|\bpublish\b/, 'instagram.publishPost');
  add(/\byoutube\b.*\bcomment\b|\breply.*comment\b/, 'youtube.replyComment');
  add(/\byoutube\b|\bupload\b/, 'youtube.uploadVideo');
  add(/\bpdf\b|\binvoice\b/, 'core.pdfGenerate', { title: 'Invoice' });
  add(/\bsheet(s)?\b|\bspreadsheet\b/, 'core.googleSheetsAppend');
  add(/\bcourier\b|\bshipment\b|\bbook.*delivery\b/, 'courier.bookShipment');
  add(/\btrack(ing)?\b/, 'courier.track');
  add(/\bdatabase\b|\bsql\b|\bdb query\b/, 'local.dbQuery');
  add(/\bwait\b|\bdelay\b/, 'core.wait', { seconds: 5 });
  add(/\bif\b|\bcondition\b/, 'core.if', { left: '{{ $json.status }}', operator: 'equals', right: '"paid"' });
  add(/\blog\b/, 'core.log', { message: 'Step completed' });
  add(/\bset\b.*\bfield|\bset data\b/, 'core.setData');

  // De-duplicate by type, keep prompt order.
  const seen = new Set<string>();
  return matches
    .sort((a, b) => a.index - b.index)
    .filter((m) => (seen.has(m.type) ? false : (seen.add(m.type), true)));
}

function pickTrigger(text: string): string {
  if (/\bwebhook\b/.test(text)) return 'core.webhookTrigger';
  if (/\bschedule\b|\bcron\b|\bevery\b|\bdaily\b|\bhourly\b/.test(text)) return 'core.cronTrigger';
  if (/\bshopify\b.*\border\b|\bnew order\b/.test(text)) return 'core.webhookTrigger';
  return 'core.manualTrigger';
}

/** Generates a workflow graph from a plain-language prompt, or null if nothing matched. */
export function generateWorkflowFromPrompt(prompt: string): GeneratedWorkflow | null {
  const text = prompt.toLowerCase();
  const actions = findActions(text);
  if (actions.length === 0) return null;

  const triggerType = pickTrigger(text);
  const chain: Array<{ type: string; params?: Record<string, unknown> }> = [
    { type: triggerType },
    ...actions.filter((a) => a.type !== triggerType),
  ];

  const nodes: WorkflowNodeInstance[] = chain.map((step, i) => {
    const def = NODE_TYPE_MAP.get(step.type);
    return {
      id: `node-${i + 1}`,
      type: step.type,
      name: def?.label ?? step.type,
      parameters: { ...defaultParameters(def ?? { type: step.type, label: step.type, category: 'core', outputs: 1, params: [] }), ...(step.params ?? {}) },
      position: { x: 80 + i * 230, y: 140 },
    };
  });
  const edges: WorkflowEdge[] = nodes.slice(1).map((node, i) => ({ from: nodes[i].id, to: node.id, output: 0 }));

  const name =
    prompt.trim().length > 0
      ? prompt.trim().replace(/\s+/g, ' ').slice(0, 60)
      : 'Copilot workflow';
  return { name, nodes, edges };
}

/** Simple static diagnostics for the Copilot "Error Doctor" pattern (spec §4A). */
export function diagnoseError(prompt: string): string | null {
  const text = prompt.toLowerCase();
  if (!/(error|fail|broken|not working|stuck)/.test(text)) return null;
  if (/401|unauthor|token|credential/.test(text)) {
    return 'That looks like a credential problem: open the Credentials Vault, delete the stored credential and add it again with a fresh API key/token, then re-run the workflow.';
  }
  if (/404|not found/.test(text)) {
    return 'A 404 usually means a wrong URL, slug or ID. Check the HTTP Request node URL and any comment/order IDs in connector nodes.';
  }
  if (/timeout|slow/.test(text)) {
    return 'Timeouts are usually the remote API being slow. Add a Wait node before the call or reduce the Limit parameter on order-listing nodes.';
  }
  return 'Open the Executions page, click the failed run and read the failing step\'s error — it names the node and the exact parameter the engine rejected. Fix that parameter on the canvas and re-run.';
}
