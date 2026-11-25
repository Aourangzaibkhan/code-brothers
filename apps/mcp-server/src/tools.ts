/**
 * @code-brothers/mcp-server — tool definitions.
 *
 * Every tool is a thin wrapper over the platform's REST API (see
 * docs/setup-guide.md and skill/reference/api.md). The server itself never
 * stores credentials: the API token comes from the CB_API_TOKEN environment
 * variable, and tool results never include secret values — the credentials
 * tool returns metadata only (the API itself never returns secret values).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpToolDefinition } from '@code-brothers/mcp-bridge';

export interface ApiResult {
  status: number;
  body: unknown;
}

export type ApiCaller = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<ApiResult>;

export interface PlatformToolsOptions {
  callApi: ApiCaller;
  templatesDir: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  return value;
}

/** Throw a readable error for any non-2xx API answer; pass 2xx bodies through. */
function expectOk(result: ApiResult, action: string): unknown {
  if (result.status >= 200 && result.status < 300) return result.body;
  const body = asRecord(result.body);
  // Keep the machine-readable error code in the message (buyers and tests
  // match on it, e.g. no_ai_provider_configured), plus the human detail.
  const code = typeof body.error === 'string' ? body.error : '';
  const detail = typeof body.message === 'string' ? body.message : '';
  const message = [code, detail].filter(Boolean).join(': ') || `HTTP ${result.status}`;
  throw new Error(`${action} failed (${result.status}): ${message}`);
}

interface TemplateFile {
  file: string;
  id: string;
  name: string;
  description: string;
  variables: string[];
  nodeTypes: string[];
}

function loadTemplates(templatesDir: string): TemplateFile[] {
  let files: string[];
  try {
    files = readdirSync(templatesDir).filter((f) => /^template-\d+-.*\.json$/.test(f));
  } catch {
    return [];
  }
  const out: TemplateFile[] = [];
  for (const file of files.sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(templatesDir, file), 'utf8')) as Record<
        string,
        unknown
      >;
      const settings = asRecord(raw.settings);
      const variables = asRecord(settings.variables);
      const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
      const nodeTypes = [
        ...new Set(
          nodes.map((n) => asRecord(n).type).filter((t): t is string => typeof t === 'string'),
        ),
      ];
      out.push({
        file,
        id: typeof raw.id === 'string' ? raw.id : file.replace(/\.json$/, ''),
        name: typeof raw.name === 'string' ? raw.name : file,
        description: typeof raw.description === 'string' ? raw.description : '',
        variables: Object.keys(variables),
        nodeTypes,
      });
    } catch {
      // A broken template file is skipped here; `node templates/validate.mjs`
      // is the authority that fails the build on it.
    }
  }
  return out;
}

function workflowSummary(w: Record<string, unknown>): Record<string, unknown> {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    isActive: w.isActive,
    currentVersion: w.currentVersion,
    tags: w.tags,
    updatedAt: w.updatedAt,
  };
}

export function createPlatformTools(opts: PlatformToolsOptions): McpToolDefinition[] {
  const { callApi, templatesDir } = opts;

  return [
    {
      name: 'codebrothers_health',
      description:
        'Check the code-brothers platform: setup state and the security health score. Use first — if setupRequired is true, the owner account has not been claimed yet.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const setup = expectOk(await callApi('GET', '/api/setup/status'), 'setup status');
        const health = expectOk(
          await callApi('GET', '/api/security/health-score'),
          'health score',
        );
        return { setup, health };
      },
    },
    {
      name: 'codebrothers_list_templates',
      description:
        'List the 10 ready-to-import automation templates bundled with code-brothers (WhatsApp sales assistant, payment verifier, stock sync, COD shield, Instagram/YouTube growth, abandoned-cart recovery, CEO digest, …). Each entry names the variables and node types it uses.',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const templates = loadTemplates(templatesDir);
        if (templates.length === 0) {
          throw new Error(
            `no template files found in ${templatesDir} — run from the repository root or set CB_TEMPLATES_DIR`,
          );
        }
        return { templates };
      },
    },
    {
      name: 'codebrothers_import_template',
      description:
        'Import one bundled template as a new workflow (inactive by default). Pass templateId like "template-01-whatsapp-sales-assistant" and any variables it needs (owner phone, product links, base URLs). Returns the created workflow id — then fill in its credentials and activate it.',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: { type: 'string' },
          variables: { type: 'object', additionalProperties: true },
        },
        required: ['templateId'],
      },
      run: async (args) => {
        const templateId = requireString(args, 'templateId');
        const templates = loadTemplates(templatesDir);
        const match = templates.find(
          (t) => t.id === templateId || t.file.replace(/\.json$/, '') === templateId,
        );
        if (!match) {
          throw new Error(
            `unknown template "${templateId}"; available: ${templates.map((t) => t.id).join(', ') || '(none found)'}`,
          );
        }
        const raw = JSON.parse(
          readFileSync(join(templatesDir, match.file), 'utf8'),
        ) as Record<string, unknown>;
        const settings = asRecord(raw.settings);
        const variables = asRecord(args.variables);
        const mergedSettings = {
          ...settings,
          variables: { ...asRecord(settings.variables), ...variables },
        };
        const created = expectOk(
          await callApi('POST', '/api/workflows', {
            name: raw.name,
            description: raw.description,
            nodes: raw.nodes,
            edges: raw.edges,
            settings: mergedSettings,
            tags: ['template', match.id],
          }),
          `import template ${match.id}`,
        );
        return workflowSummary(asRecord(created));
      },
    },
    {
      name: 'codebrothers_list_workflows',
      description: 'List the owner workflows on this code-brothers instance (id, name, active state, version).',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const body = asRecord(
          expectOk(await callApi('GET', '/api/workflows'), 'list workflows'),
        );
        const workflows = Array.isArray(body.workflows) ? body.workflows : [];
        return { workflows: workflows.map((w) => workflowSummary(asRecord(w))) };
      },
    },
    {
      name: 'codebrothers_get_workflow',
      description: 'Fetch one workflow in full (nodes, edges, settings) so you can inspect or edit it.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      run: async (args) => {
        const id = requireString(args, 'id');
        return expectOk(await callApi('GET', `/api/workflows/${id}`), `get workflow ${id}`);
      },
    },
    {
      name: 'codebrothers_import_workflow',
      description:
        'Create a new workflow from a full definition (name, nodes, edges, settings). New workflows start inactive — activate them with codebrothers_set_workflow_active after verifying them.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          nodes: { type: 'array' },
          edges: { type: 'array' },
          settings: { type: 'object' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['name'],
      },
      run: async (args) => {
        const created = expectOk(
          await callApi('POST', '/api/workflows', {
            name: args.name,
            description: args.description,
            nodes: args.nodes ?? [],
            edges: args.edges ?? [],
            settings: args.settings ?? {},
            tags: args.tags ?? [],
          }),
          'create workflow',
        );
        return workflowSummary(asRecord(created));
      },
    },
    {
      name: 'codebrothers_run_workflow',
      description:
        'Run a workflow manually with optional trigger data and variables. Returns the execution record (id, status). Check the result with codebrothers_list_runs.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          triggerData: { type: 'object' },
          variables: { type: 'object' },
        },
        required: ['id'],
      },
      run: async (args) => {
        const id = requireString(args, 'id');
        return expectOk(
          await callApi('POST', `/api/workflows/${id}/run`, {
            triggerData: args.triggerData,
            variables: args.variables,
          }),
          `run workflow ${id}`,
        );
      },
    },
    {
      name: 'codebrothers_set_workflow_active',
      description:
        'Activate or deactivate a workflow. Only activate a workflow after its credentials and variables are filled in and a manual run has succeeded.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          active: { type: 'boolean' },
        },
        required: ['id', 'active'],
      },
      run: async (args) => {
        const id = requireString(args, 'id');
        if (typeof args.active !== 'boolean') {
          throw new Error('active is required and must be a boolean');
        }
        const action = args.active ? 'activate' : 'deactivate';
        const updated = expectOk(
          await callApi('POST', `/api/workflows/${id}/${action}`, {}),
          `${action} workflow ${id}`,
        );
        return workflowSummary(asRecord(updated));
      },
    },
    {
      name: 'codebrothers_list_runs',
      description:
        'List recent workflow executions (optionally filtered by workflowId, newest first). Use it to verify a manual run succeeded or to find why one failed.',
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          limit: { type: 'number' },
        },
      },
      run: async (args) => {
        const limit =
          typeof args.limit === 'number' ? Math.min(Math.max(Math.floor(args.limit), 1), 100) : 20;
        const qs = new URLSearchParams({ limit: String(limit) });
        if (typeof args.workflowId === 'string' && args.workflowId !== '') {
          qs.set('workflowId', args.workflowId);
        }
        return expectOk(
          await callApi('GET', `/api/executions?${qs.toString()}`),
          'list executions',
        );
      },
    },
    {
      name: 'codebrothers_list_credentials',
      description:
        'List stored credentials by name, provider and kind (metadata only — secret values are never returned). Use it to check which accounts are connected before running a template that needs them.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        return expectOk(await callApi('GET', '/api/credentials'), 'list credentials');
      },
    },
    {
      name: 'codebrothers_ai_chat',
      description:
        'Ask the built-in AI Copilot (Ollama / Gemini / Groq / OpenRouter with automatic fallback). Answers 503 when no AI provider is configured — that is honest behaviour, not an error in this skill.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
      run: async (args) => {
        const message = requireString(args, 'message');
        return expectOk(
          await callApi('POST', '/api/ai/chat', {
            messages: [{ role: 'user', content: message }],
          }),
          'AI chat',
        );
      },
    },
  ];
}
