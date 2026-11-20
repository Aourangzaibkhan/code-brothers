/**
 * Stdio transport: spawns an MCP server process (shell: false, always)
 * and speaks newline-delimited JSON-RPC over its stdin/stdout.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  McpTransport,
  MessageHandler,
} from './transport.js';

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export class StdioTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private handler?: MessageHandler;
  private buffer = '';
  private closed = false;

  constructor(opts: StdioTransportOptions) {
    this.child = spawn(opts.command, opts.args ?? [], {
      shell: false,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          this.handler?.(msg);
        } catch {
          /* ignore non-JSON noise on stdout */
        }
      }
    });
  }

  /** stderr of the child, for diagnostics (never parsed as protocol). */
  get stderr(): NodeJS.ReadableStream {
    return this.child.stderr;
  }

  async send(msg: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (this.closed) throw new Error('stdio transport closed');
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(msg)}\n`, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
  }
}
