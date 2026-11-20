/**
 * Minimal MCP client: JSON-RPC 2.0 over any McpTransport — initialize
 * handshake, tools/list, tools/call.
 */

import {
  isResponse,
  type JsonRpcRequest,
  type McpTransport,
} from './transport.js';
import {
  MCP_PROTOCOL_VERSION,
  type CallToolResult,
  type McpToolInfo,
} from './server.js';

export interface InitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version: string };
}

export class McpRemoteError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'McpRemoteError';
    this.code = code;
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: unknown): void;
}

export class McpClient {
  private readonly transport: McpTransport;
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private serverInfo?: InitializeResult;

  constructor(transport: McpTransport) {
    this.transport = transport;
    transport.onMessage((msg) => {
      if (!isResponse(msg)) return;
      const entry = this.pending.get(msg.id as number | string);
      if (!entry) return;
      this.pending.delete(msg.id as number | string);
      if (msg.error) entry.reject(new McpRemoteError(msg.error.code, msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.transport.send(req).catch((err) => {
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  async initialize(clientInfo = { name: 'code-brothers', version: '0.1.0' }): Promise<InitializeResult> {
    const result = await this.request<InitializeResult>('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    });
    this.serverInfo = result;
    await this.transport.send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    return result;
  }

  getServerInfo(): InitializeResult | undefined {
    return this.serverInfo;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.request<{ tools: McpToolInfo[] }>('tools/list');
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallToolResult> {
    return this.request<CallToolResult>('tools/call', { name, arguments: args });
  }

  async close(): Promise<void> {
    for (const entry of this.pending.values()) {
      entry.reject(new Error('client closed'));
    }
    this.pending.clear();
    await this.transport.close?.();
  }
}
