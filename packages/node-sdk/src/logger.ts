import type { NodeLogger } from './types.js';

/** A function that returns a redacted deep copy of a loggable value. */
export type RedactorFn = (value: unknown) => unknown;

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
  at: string;
}

/** In-memory logger — used by tests and as the engine's default sink. */
export class MemoryNodeLogger implements NodeLogger {
  readonly entries: LogEntry[] = [];

  private push(
    level: LogEntry['level'],
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    this.entries.push({ level, message, meta, at: new Date().toISOString() });
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.push('debug', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.push('info', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.push('warn', message, meta);
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.push('error', message, meta);
  }
}

/** Minimal console logger for local development runs. */
export class ConsoleNodeLogger implements NodeLogger {
  debug(message: string, meta?: Record<string, unknown>): void {
    console.debug(message, meta ?? '');
  }
  info(message: string, meta?: Record<string, unknown>): void {
    console.info(message, meta ?? '');
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(message, meta ?? '');
  }
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(message, meta ?? '');
  }
}

/**
 * Wrap a logger so every meta payload is passed through the platform
 * redactor before it reaches the sink. This is how node loggers become
 * "already-redacted": nodes cannot accidentally leak secrets into logs.
 */
export function createRedactingLogger(
  base: NodeLogger,
  redactor: RedactorFn,
): NodeLogger {
  const wrap =
    (level: LogEntry['level']) =>
    (message: string, meta?: Record<string, unknown>): void => {
      base[level](message, meta ? (redactor(meta) as Record<string, unknown>) : meta);
    };
  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
  };
}
