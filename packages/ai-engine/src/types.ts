/**
 * Shared types for the Code Brothers AI engine (spec §4C).
 *
 * Every provider speaks the real HTTP API shape of its service, but the
 * `fetch` implementation is injectable so the whole engine can be tested
 * against local mock servers / stubs — no real API keys required.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Tool name, when role === 'tool'. */
  name?: string;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResult {
  text: string;
  usage?: ChatUsage;
  /** Name of the provider that produced this result. */
  provider: string;
  model: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Minimal fetch surface (compatible with the global fetch). */
export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ChatProvider {
  readonly name: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
}

/** A provider holding several API keys that the router can rotate through. */
export interface KeyRotatingProvider extends ChatProvider {
  readonly keyCount: number;
  readonly keyIndex: number;
  /** Advance to the next key (round-robin). No-op for keyless providers. */
  rotateKey(): void;
}

/**
 * Error thrown by provider clients. `retryable` is true for HTTP 429, 5xx
 * and network failures — exactly the cases the HybridRouter falls back on.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    provider: string,
    message: string,
    opts: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = opts.status;
    this.retryable =
      opts.retryable ??
      (opts.status === undefined || opts.status === 429 || opts.status >= 500);
  }
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  // Unknown errors (DNS, socket resets, aborts from fetch) are treated as
  // transient network failures so the router can fall back.
  return true;
}
