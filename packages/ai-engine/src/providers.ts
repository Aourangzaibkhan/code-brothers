/**
 * Provider clients for the zero-cost hybrid AI router (spec §4C).
 *
 * - OllamaProvider        — local Ollama, POST /api/chat (no key).
 * - GeminiProvider        — Google Gemini generateContent REST shape.
 * - GroqProvider          — OpenAI-compatible /chat/completions.
 * - OpenRouterProvider    — OpenAI-compatible /chat/completions.
 *
 * All take an injectable `fetch` so tests run against mock servers only.
 */

import {
  ProviderError,
  type ChatMessage,
  type ChatOptions,
  type ChatProvider,
  type ChatResult,
  type FetchLike,
  type KeyRotatingProvider,
} from './types.js';

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

async function postJson(
  provider: string,
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new ProviderError(
      provider,
      `network error calling ${provider}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* body unreadable — status alone is enough */
    }
    throw new ProviderError(
      provider,
      `${provider} request failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
      { status: res.status },
    );
  }
  try {
    return await res.json();
  } catch (err) {
    throw new ProviderError(provider, `${provider} returned invalid JSON`, {
      cause: err,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Ollama (local, keyless)                                             */
/* ------------------------------------------------------------------ */

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
}

export class OllamaProvider implements KeyRotatingProvider {
  readonly name = 'ollama';
  readonly keyCount = 0;
  readonly keyIndex = 0;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.model = opts.model ?? 'qwen2.5:7b';
    this.fetchFn = opts.fetch ?? defaultFetch;
  }

  rotateKey(): void {
    /* keyless — nothing to rotate */
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model ?? this.model;
    const json = (await postJson(
      this.name,
      this.fetchFn,
      `${this.baseUrl}/api/chat`,
      {},
      {
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        options: {
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.maxTokens !== undefined ? { num_predict: opts.maxTokens } : {}),
        },
      },
      opts.signal,
    )) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const prompt = json.prompt_eval_count;
    const completion = json.eval_count;
    return {
      text: json.message?.content ?? '',
      provider: this.name,
      model,
      usage:
        prompt !== undefined || completion !== undefined
          ? {
              promptTokens: prompt,
              completionTokens: completion,
              totalTokens:
                prompt !== undefined && completion !== undefined
                  ? prompt + completion
                  : undefined,
            }
          : undefined,
    };
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible base (Groq, OpenRouter)                           */
/* ------------------------------------------------------------------ */

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKeys: string[];
  model: string;
  fetch?: FetchLike;
  extraHeaders?: Record<string, string>;
}

abstract class OpenAICompatibleProvider implements KeyRotatingProvider {
  abstract readonly name: string;
  protected readonly baseUrl: string;
  protected readonly keys: string[];
  protected readonly model: string;
  protected readonly fetchFn: FetchLike;
  protected readonly extraHeaders: Record<string, string>;
  #keyIndex = 0;

  constructor(opts: OpenAICompatibleOptions) {
    if (!opts.apiKeys.length) {
      throw new Error('at least one API key is required');
    }
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.keys = [...opts.apiKeys];
    this.model = opts.model;
    this.fetchFn = opts.fetch ?? defaultFetch;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  get keyCount(): number {
    return this.keys.length;
  }

  get keyIndex(): number {
    return this.#keyIndex;
  }

  rotateKey(): void {
    this.#keyIndex = (this.#keyIndex + 1) % this.keys.length;
  }

  protected currentKey(): string {
    return this.keys[this.#keyIndex]!;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model ?? this.model;
    const json = (await postJson(
      this.name,
      this.fetchFn,
      `${this.baseUrl}/chat/completions`,
      {
        authorization: `Bearer ${this.currentKey()}`,
        ...this.extraHeaders,
      },
      {
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.name ? { name: m.name } : {}),
        })),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      },
      opts.signal,
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const usage = json.usage;
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      provider: this.name,
      model,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }
        : undefined,
    };
  }
}

export interface GroqOptions {
  apiKeys: string[];
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
}

export class GroqProvider extends OpenAICompatibleProvider {
  readonly name = 'groq';
  constructor(opts: GroqOptions) {
    super({
      baseUrl: opts.baseUrl ?? 'https://api.groq.com/openai/v1',
      apiKeys: opts.apiKeys,
      model: opts.model ?? 'llama-3.3-70b-versatile',
      fetch: opts.fetch,
    });
  }
}

export interface OpenRouterOptions {
  apiKeys: string[];
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
  referer?: string;
  title?: string;
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  readonly name = 'openrouter';
  constructor(opts: OpenRouterOptions) {
    super({
      baseUrl: opts.baseUrl ?? 'https://openrouter.ai/api/v1',
      apiKeys: opts.apiKeys,
      model: opts.model ?? 'meta-llama/llama-3.3-70b-instruct:free',
      fetch: opts.fetch,
      extraHeaders: {
        ...(opts.referer ? { 'http-referer': opts.referer } : {}),
        ...(opts.title ? { 'x-title': opts.title } : {}),
      },
    });
  }
}

/* ------------------------------------------------------------------ */
/* Gemini (generateContent REST)                                       */
/* ------------------------------------------------------------------ */

export interface GeminiOptions {
  apiKeys: string[];
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
}

interface GeminiPart {
  text: string;
}

export class GeminiProvider implements KeyRotatingProvider {
  readonly name = 'gemini';
  private readonly baseUrl: string;
  private readonly keys: string[];
  private readonly model: string;
  private readonly fetchFn: FetchLike;
  #keyIndex = 0;

  constructor(opts: GeminiOptions) {
    if (!opts.apiKeys.length) {
      throw new Error('at least one API key is required');
    }
    this.baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(
      /\/$/,
      '',
    );
    this.keys = [...opts.apiKeys];
    this.model = opts.model ?? 'gemini-2.0-flash';
    this.fetchFn = opts.fetch ?? defaultFetch;
  }

  get keyCount(): number {
    return this.keys.length;
  }

  get keyIndex(): number {
    return this.#keyIndex;
  }

  rotateKey(): void {
    this.#keyIndex = (this.#keyIndex + 1) % this.keys.length;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model ?? this.model;
    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }] as GeminiPart[],
      }));
    const json = (await postJson(
      this.name,
      this.fetchFn,
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      // x-goog-api-key is the documented header form; keeps keys out of URLs/logs.
      { 'x-goog-api-key': this.keys[this.#keyIndex]! },
      {
        ...(systemText
          ? { systemInstruction: { parts: [{ text: systemText }] } }
          : {}),
        contents,
        generationConfig: {
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.maxTokens !== undefined
            ? { maxOutputTokens: opts.maxTokens }
            : {}),
        },
      },
      opts.signal,
    )) as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const usage = json.usageMetadata;
    return {
      text: parts.map((p) => p.text).join(''),
      provider: this.name,
      model,
      usage: usage
        ? {
            promptTokens: usage.promptTokenCount,
            completionTokens: usage.candidatesTokenCount,
            totalTokens: usage.totalTokenCount,
          }
        : undefined,
    };
  }
}

export type AnyProvider = ChatProvider;
