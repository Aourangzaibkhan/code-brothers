/**
 * @code-brothers/mcp-server — MCP server for a code-brothers instance.
 *
 * Speaks JSON-RPC 2.0 over stdio (the same protocol as
 * @code-brothers/mcp-bridge) and exposes the platform's REST API as MCP
 * tools, so the buyer's own agent can drive their own self-hosted instance:
 * list/import/run workflows, check executions, list templates and
 * credentials, and ask the AI Copilot.
 *
 * Configuration (environment):
 *   CB_API_URL       Base URL of the platform API (default http://127.0.0.1:3000)
 *   CB_API_TOKEN     Owner session token (required) — log in once via
 *                    POST /api/auth/login and paste the token here. It is
 *                    sent as an Authorization header and is NEVER printed.
 *   CB_TEMPLATES_DIR Directory with the template-*.json files
 *                    (default <current working directory>/templates)
 *
 * Run from the repository root:
 *   npm run build --workspace=@code-brothers/mcp-server
 *   CB_API_URL=http://127.0.0.1:3000 CB_API_TOKEN=<token> npm start --workspace=@code-brothers/mcp-server
 *
 * All diagnostics go to stderr — stdout is the protocol channel.
 */

import { join } from 'node:path';
import { McpServer, createStdioServerTransport } from '@code-brothers/mcp-bridge';
import { createPlatformTools, type ApiResult } from './tools.js';

async function callApi(
  apiUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `cannot reach the code-brothers API at ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: res.status, body: parsed };
}

function main(): void {
  const apiUrl = (process.env.CB_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const token = process.env.CB_API_TOKEN;
  if (!token) {
    console.error(
      'code-brothers MCP server: CB_API_TOKEN is required.\n' +
        'Log in once: curl -X POST $CB_API_URL/api/auth/login -d \'{"email":"owner@example.com","password":"..."}\'\n' +
        'and set CB_API_TOKEN to the token from the response. The token is never printed by this server.',
    );
    process.exit(1);
  }
  const templatesDir = process.env.CB_TEMPLATES_DIR ?? join(process.cwd(), 'templates');

  const server = new McpServer({ name: 'code-brothers', version: '0.1.0' });
  const tools = createPlatformTools({
    callApi: (method, path, body) => callApi(apiUrl, token, method, path, body),
    templatesDir,
  });
  for (const tool of tools) server.registerTool(tool);
  server.connect(createStdioServerTransport());
  console.error(
    `code-brothers MCP server ready: ${tools.length} tools, API ${apiUrl}, templates ${templatesDir}`,
  );
}

main();
