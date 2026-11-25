/**
 * JSON-RPC 2.0 types + transports for the MCP bridge (spec §4D).
 *
 * A transport is deliberately tiny — send a message, register a handler —
 * so the client and server can run over an in-memory channel (tests,
 * in-process community tools) or over a child process's stdio.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export type MessageHandler = (msg: JsonRpcMessage) => void;

export interface McpTransport {
  send(msg: JsonRpcRequest | JsonRpcNotification): Promise<void>;
  onMessage(handler: MessageHandler): void;
  close?(): Promise<void>;
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg);
}

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg;
}

/* ------------------------------------------------------------------ */
/* In-memory transport pair                                            */
/* ------------------------------------------------------------------ */

class InMemoryTransport implements McpTransport {
  peer?: InMemoryTransport;
  private handler?: MessageHandler;
  private closed = false;

  async send(msg: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (this.closed) throw new Error('transport closed');
    const peer = this.peer;
    const handler = peer?.handler;
    if (!peer || !handler) return;
    const copy = structuredClone(msg) as JsonRpcMessage;
    queueMicrotask(() => {
      if (!peer.closed) handler(copy);
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handler = undefined;
  }
}

/** Two connected endpoints: [clientSide, serverSide]. */
export function createInMemoryTransportPair(): [McpTransport, McpTransport] {
  const a = new InMemoryTransport();
  const b = new InMemoryTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/* ------------------------------------------------------------------ */
/* Stdio server transport (this process IS the server)                 */
/* ------------------------------------------------------------------ */

/**
 * A transport for an MCP server that runs as a child process: reads
 * newline-delimited JSON-RPC from stdin and writes responses to stdout.
 *
 * stdout is the protocol channel — never write diagnostics there; use
 * stderr. Mirrors the client-side {@link StdioTransport} in stdio.ts.
 */
export function createStdioServerTransport(): McpTransport {
  let handler: MessageHandler | undefined;
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        handler?.(JSON.parse(line) as JsonRpcMessage);
      } catch {
        /* ignore non-JSON noise on stdin */
      }
    }
  });
  return {
    async send(msg: JsonRpcRequest | JsonRpcNotification): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(`${JSON.stringify(msg)}\n`, (err) =>
          err ? reject(err) : resolve(),
        );
      });
    },
    onMessage(h: MessageHandler): void {
      handler = h;
    },
    async close(): Promise<void> {
      process.stdin.destroy();
    },
  };
}
