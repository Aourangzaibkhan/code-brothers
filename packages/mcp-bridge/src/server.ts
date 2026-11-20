/**
 * Minimal MCP server: exposes locally-registered tools over any
 * McpTransport, answering initialize / tools/list / tools/call.
 */

import {
  isRequest,
  type JsonRpcResponse,
  type McpTransport,
} from './transport.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the arguments object. */
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

export interface McpServerOptions {
  name?: string;
  version?: string;
}

export class McpServer {
  private readonly name: string;
  private readonly version: string;
  private readonly tools = new Map<string, McpToolDefinition>();
  private transport?: McpTransport;

  constructor(opts: McpServerOptions = {}) {
    this.name = opts.name ?? 'code-brothers-mcp';
    this.version = opts.version ?? '0.1.0';
  }

  registerTool(def: McpToolDefinition): this {
    if (!def.name) throw new Error('tool needs a name');
    if (this.tools.has(def.name)) throw new Error(`tool "${def.name}" already registered`);
    this.tools.set(def.name, def);
    return this;
  }

  listTools(): McpToolInfo[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  connect(transport: McpTransport): void {
    this.transport = transport;
    transport.onMessage((msg) => {
      void this.handle(msg);
    });
  }

  private async respond(response: JsonRpcResponse): Promise<void> {
    // Transports only carry requests/notifications on send(); a response
    // travels the same channel, so cast to the wire shape.
    await this.transport?.send(response as never);
  }

  private async handle(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object' || !('method' in msg)) return;
    const req = msg as { method: string; id?: number | string; params?: unknown };
    const hasId = req.id !== undefined && req.id !== null;

    switch (req.method) {
      case 'initialize': {
        if (hasId) {
          await this.respond({
            jsonrpc: '2.0',
            id: req.id!,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: this.name, version: this.version },
            },
          });
        }
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled': {
        return; // notifications: never answered
      }
      case 'ping': {
        if (hasId) await this.respond({ jsonrpc: '2.0', id: req.id!, result: {} });
        return;
      }
      case 'tools/list': {
        if (hasId) {
          await this.respond({
            jsonrpc: '2.0',
            id: req.id!,
            result: { tools: this.listTools() },
          });
        }
        return;
      }
      case 'tools/call': {
        if (!hasId) return;
        const params = (req.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        const tool = params.name ? this.tools.get(params.name) : undefined;
        if (!tool) {
          await this.respond({
            jsonrpc: '2.0',
            id: req.id!,
            error: {
              code: -32602,
              message: `unknown tool: ${params.name ?? '(missing name)'}`,
            },
          });
          return;
        }
        try {
          const out = await tool.run(params.arguments ?? {});
          const text = typeof out === 'string' ? out : (JSON.stringify(out) ?? 'null');
          const result: CallToolResult = {
            content: [{ type: 'text', text }],
            isError: false,
          };
          await this.respond({ jsonrpc: '2.0', id: req.id!, result });
        } catch (err) {
          // MCP convention: tool failures come back as an isError result,
          // not a protocol error.
          const result: CallToolResult = {
            content: [
              { type: 'text', text: err instanceof Error ? err.message : String(err) },
            ],
            isError: true,
          };
          await this.respond({ jsonrpc: '2.0', id: req.id!, result });
        }
        return;
      }
      default: {
        if (hasId && isRequest(msg as never)) {
          await this.respond({
            jsonrpc: '2.0',
            id: req.id!,
            error: { code: -32601, message: `method not found: ${req.method}` },
          });
        }
      }
    }
  }
}
