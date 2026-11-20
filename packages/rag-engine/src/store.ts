/**
 * Vector stores (spec §4D / §9: `knowledge_documents` & `embeddings`).
 *
 * Workspace isolation is a hard invariant: a search issued for workspace A
 * must never return workspace B chunks. InMemoryVectorStore filters by
 * workspace BEFORE scoring; PgVectorStore puts `workspace_id = $n` in the
 * WHERE clause of the generated SQL.
 */

import type { Chunk } from './chunker.js';

export interface StoredChunk extends Chunk {
  embedding: number[];
}

export interface SearchHit {
  chunk: StoredChunk;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

export interface VectorStore {
  add(chunks: StoredChunk[]): Promise<void>;
  search(workspaceId: string, embedding: number[], k: number): Promise<SearchHit[]>;
  count(workspaceId?: string): Promise<number>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/* ------------------------------------------------------------------ */
/* In-memory store                                                     */
/* ------------------------------------------------------------------ */

export class InMemoryVectorStore implements VectorStore {
  private readonly chunks: StoredChunk[] = [];

  async add(chunks: StoredChunk[]): Promise<void> {
    this.chunks.push(...chunks);
  }

  async search(workspaceId: string, embedding: number[], k: number): Promise<SearchHit[]> {
    return this.chunks
      .filter((c) => c.workspaceId === workspaceId) // isolation first, always
      .map((chunk) => ({ chunk, score: cosineSimilarity(embedding, chunk.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k));
  }

  async count(workspaceId?: string): Promise<number> {
    if (workspaceId === undefined) return this.chunks.length;
    return this.chunks.filter((c) => c.workspaceId === workspaceId).length;
  }
}

/* ------------------------------------------------------------------ */
/* pgvector store (SQL generation + injectable executor)               */
/* ------------------------------------------------------------------ */

export interface SqlStatement {
  sql: string;
  params: unknown[];
}

export type SqlExecutor = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export const EMBEDDINGS_TABLE = 'embeddings';

/** pgvector literal format: '[0.1,0.2,...]'. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export class PgVectorStore implements VectorStore {
  private readonly executor?: SqlExecutor;

  constructor(executor?: SqlExecutor) {
    this.executor = executor;
  }

  static buildInsert(chunk: StoredChunk): SqlStatement {
    return {
      sql:
        `INSERT INTO ${EMBEDDINGS_TABLE} ` +
        '(id, workspace_id, document_id, chunk_index, content, metadata, embedding) ' +
        'VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::vector) ' +
        'ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, ' +
        'metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding',
      params: [
        chunk.id,
        chunk.workspaceId,
        chunk.docId,
        chunk.chunkIndex,
        chunk.text,
        JSON.stringify(chunk.metadata ?? {}),
        toVectorLiteral(chunk.embedding),
      ],
    };
  }

  static buildSearch(workspaceId: string, embedding: number[], k: number): SqlStatement {
    return {
      sql:
        `SELECT id, workspace_id, document_id, chunk_index, content, metadata, ` +
        `1 - (embedding <=> $1::vector) AS score ` +
        `FROM ${EMBEDDINGS_TABLE} ` +
        'WHERE workspace_id = $2 ' +
        'ORDER BY embedding <=> $1::vector ' +
        'LIMIT $3',
      params: [toVectorLiteral(embedding), workspaceId, k],
    };
  }

  private requireExecutor(): SqlExecutor {
    if (!this.executor) {
      throw new Error(
        'PgVectorStore has no SQL executor — pass one to the constructor (SQL builders are static for testing).',
      );
    }
    return this.executor;
  }

  async add(chunks: StoredChunk[]): Promise<void> {
    const exec = this.requireExecutor();
    for (const chunk of chunks) {
      const stmt = PgVectorStore.buildInsert(chunk);
      await exec(stmt.sql, stmt.params);
    }
  }

  async search(workspaceId: string, embedding: number[], k: number): Promise<SearchHit[]> {
    const exec = this.requireExecutor();
    const stmt = PgVectorStore.buildSearch(workspaceId, embedding, k);
    const { rows } = await exec(stmt.sql, stmt.params);
    return rows.map((row) => ({
      score: Number(row.score ?? 0),
      chunk: {
        id: String(row.id),
        docId: String(row.document_id),
        workspaceId: String(row.workspace_id),
        chunkIndex: Number(row.chunk_index),
        text: String(row.content),
        metadata:
          typeof row.metadata === 'string'
            ? (JSON.parse(row.metadata) as Record<string, unknown>)
            : ((row.metadata as Record<string, unknown>) ?? {}),
        embedding: [],
      },
    }));
  }

  async count(workspaceId?: string): Promise<number> {
    const exec = this.requireExecutor();
    const { rows } = workspaceId
      ? await exec(
          `SELECT COUNT(*)::int AS n FROM ${EMBEDDINGS_TABLE} WHERE workspace_id = $1`,
          [workspaceId],
        )
      : await exec(`SELECT COUNT(*)::int AS n FROM ${EMBEDDINGS_TABLE}`, []);
    return Number(rows[0]?.n ?? 0);
  }
}
