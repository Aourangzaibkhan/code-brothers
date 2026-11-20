/**
 * Embedders (spec §4D). The production embedder is local `bge-m3` served
 * by Ollama (/api/embeddings); HashEmbedder is a deterministic, dependency
 * -free embedder for tests and fully-offline development.
 */

export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/* ------------------------------------------------------------------ */
/* Ollama bge-m3                                                       */
/* ------------------------------------------------------------------ */

export interface OllamaEmbedderOptions {
  baseUrl?: string;
  model?: string;
  /** bge-m3 output size. */
  dimensions?: number;
  fetch?: FetchLike;
}

export class OllamaEmbedder implements Embedder {
  readonly name = 'ollama';
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: OllamaEmbedderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.model = opts.model ?? 'bge-m3';
    this.dimensions = opts.dimensions ?? 1024;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: text }),
        });
      } catch (err) {
        throw new Error(
          `ollama embeddings network error: ${(err as Error).message}`,
          { cause: err },
        );
      }
      if (!res.ok) {
        throw new Error(`ollama embeddings failed with HTTP ${res.status}`);
      }
      const json = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(json.embedding)) {
        throw new Error('ollama embeddings response missing "embedding" array');
      }
      out.push(json.embedding);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic hash embedder (tests / offline)                       */
/* ------------------------------------------------------------------ */

function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Bag-of-words hashing embedder: each token votes (+1/-1) into a bucket
 * chosen by its FNV-1a hash; the vector is L2-normalized. Deterministic
 * across runs and processes, and texts sharing vocabulary land close
 * together — good enough for tests and offline demos, NOT a semantic
 * model (use bge-m3 in production).
 */
export class HashEmbedder implements Embedder {
  readonly name = 'hash';
  readonly dimensions: number;

  constructor(dimensions = 64) {
    if (dimensions < 8) throw new Error('dimensions must be at least 8');
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const token of tokens) {
      const hash = fnv1a(token);
      const bucket = hash % this.dimensions;
      const sign = (hash >>> 8) % 2 === 0 ? 1 : -1;
      vec[bucket] = (vec[bucket] ?? 0) + sign;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
}
