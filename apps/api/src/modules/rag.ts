/**
 * Retrieval endpoint for the WhatsApp sales-assistant template
 * (templates/template-01): `POST /api/rag/search`.
 *
 * Sources, in order:
 *  1. Knowledge documents the owner uploads at POST /api/rag/documents
 *     (chunked + embedded with the keyless HashEmbedder, searched by
 *     cosine similarity over an in-memory vector store).
 *  2. The SKU-mapping catalog from the ops state — every mapped product
 *     is searchable by name/SKU even with zero uploaded documents.
 *
 * Auth: a valid session, OR a request from loopback — the workflow engine
 * calls this endpoint from the same host (the shipped template posts to
 * http://localhost:3000/api/rag/search). Search is read-only and returns
 * catalog data only, never credentials.
 *
 * Persistence: documents live in memory in this build; the Pg-backed
 * knowledge_documents table (migrations 0006/0007) is wired in when a
 * DATABASE_URL pool is attached (see gap 3).
 *
 * When a pool is attached (RagState.pool), every added document is also
 * written to knowledge_documents, and loadRagDocuments() re-indexes the
 * owner's rows into the in-memory vector store at boot (vectors are
 * rebuilt with the keyless HashEmbedder — the pgvector embeddings table
 * is only used when the pgvector extension is installed). Without a pool
 * the state is purely in-memory and documents are lost on restart.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from '@code-brothers/database';
import {
  HashEmbedder,
  InMemoryVectorStore,
  chunkDocument,
} from '@code-brothers/rag-engine';
import type { OpsState } from './state.js';

export interface RagDocument {
  id: string;
  title: string;
  content: string;
  /** Optional commerce facts the template needs: price, stock, sku. */
  metadata?: Record<string, unknown>;
}

export interface RagResult {
  answer: string;
  price: number | null;
  stock: number;
  lineItemsJson: string;
  sku: string;
  title: string;
  score: number;
  source: 'document' | 'catalog';
}

export interface RagState {
  documents: Map<string, RagDocument>;
  store: InMemoryVectorStore;
  embedder: HashEmbedder;
  workspaceId: string;
  /** Attached Pg pool (DATABASE_URL set) — documents persist across restarts. */
  pool?: Pool;
}

export function createRagState(workspaceId = 'default'): RagState {
  return {
    documents: new Map(),
    store: new InMemoryVectorStore(),
    embedder: new HashEmbedder(),
    workspaceId,
  };
}

export async function addRagDocument(
  state: RagState,
  doc: Omit<RagDocument, 'id'> & { id?: string },
  opts: { userId?: string; persist?: boolean } = {},
): Promise<RagDocument> {
  const full: RagDocument = {
    id: doc.id ?? randomUUID(),
    title: doc.title,
    content: doc.content,
    metadata: doc.metadata ?? {},
  };
  const chunks = chunkDocument({
    id: full.id,
    workspaceId: state.workspaceId,
    text: `${full.title}\n${full.content}`,
    metadata: full.metadata,
  });
  const embeddings = await state.embedder.embed(chunks.map((c) => c.text));
  await state.store.add(
    chunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] ?? [] })),
  );
  state.documents.set(full.id, full);
  // Persist alongside the in-memory index when a pool + owner are known.
  if (state.pool && opts.userId && opts.persist !== false) {
    await state.pool.query(
      `INSERT INTO knowledge_documents (id, user_id, workspace_id, title, source_type, content, metadata)
       VALUES ($1, $2, $3, $4, 'manual', $5, $6::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        full.id,
        opts.userId,
        opts.userId,
        full.title,
        full.content,
        JSON.stringify(full.metadata ?? {}),
      ],
    );
  }
  return full;
}

/**
 * Re-index the owner's persisted documents into the in-memory vector store
 * (boot-time recovery). Vectors are rebuilt with the HashEmbedder, so this
 * works on plain PostgreSQL without the pgvector extension.
 */
export async function loadRagDocuments(
  state: RagState,
  pool: Pool,
  userId: string,
): Promise<number> {
  state.pool = pool;
  state.workspaceId = userId;
  const { rows } = await pool.query(
    `SELECT id, title, content, metadata FROM knowledge_documents
     WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  let loaded = 0;
  for (const row of rows as Record<string, unknown>[]) {
    await addRagDocument(
      state,
      {
        id: String(row['id']),
        title: String(row['title']),
        content: String(row['content'] ?? ''),
        metadata:
          row['metadata'] && typeof row['metadata'] === 'object'
            ? (row['metadata'] as Record<string, unknown>)
            : {},
      },
      { persist: false },
    );
    loaded += 1;
  }
  return loaded;
}

function queryTokens(query: string): string[] {
  return query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function tokenOverlap(query: string, text: string): number {
  const q = new Set(queryTokens(query));
  if (q.size === 0) return 0;
  const t = new Set(queryTokens(text));
  let hits = 0;
  for (const token of q) if (t.has(token)) hits += 1;
  return hits / q.size;
}

export async function searchRag(
  state: RagState,
  ops: OpsState,
  query: string,
  limit = 3,
): Promise<{ results: RagResult[] }> {
  const results: RagResult[] = [];

  // 1. Knowledge documents (vector search; keyword overlap as a floor).
  if (state.documents.size > 0) {
    const [embedding] = await state.embedder.embed([query]);
    const hits = await state.store.search(
      state.workspaceId,
      embedding ?? [],
      Math.max(limit, 5),
    );
    for (const hit of hits) {
      const doc = state.documents.get(hit.chunk.docId);
      if (!doc) continue;
      const overlap = tokenOverlap(query, hit.chunk.text);
      const score = Math.max(hit.score, overlap * 0.9);
      if (score <= 0.05) continue;
      const price =
        typeof doc.metadata?.price === 'number' ? doc.metadata.price : null;
      const stock =
        typeof doc.metadata?.stock === 'number' ? doc.metadata.stock : 0;
      const sku =
        typeof doc.metadata?.sku === 'string'
          ? doc.metadata.sku
          : doc.title;
      const lineItemsJson =
        typeof doc.metadata?.lineItemsJson === 'string'
          ? doc.metadata.lineItemsJson
          : JSON.stringify([
              {
                title: doc.title,
                quantity: 1,
                ...(price !== null ? { price } : {}),
              },
            ]);
      results.push({
        answer: hit.chunk.text,
        price,
        stock,
        lineItemsJson,
        sku,
        title: doc.title,
        score,
        source: 'document',
      });
    }
  }

  // 2. SKU catalog — every mapped product is an answer candidate.
  for (const mapping of ops.skuMappings.values()) {
    const price =
      mapping.prices.local ??
      mapping.prices.shopify ??
      mapping.prices.daraz ??
      null;
    const stock = Object.values(mapping.stock).reduce((a, b) => a + b, 0);
    const overlap = tokenOverlap(query, mapping.masterSku);
    if (overlap <= 0 && results.length > 0) continue;
    results.push({
      answer:
        `${mapping.masterSku}: ` +
        (price !== null ? `price ${price}, ` : '') +
        `${stock} unit${stock === 1 ? '' : 's'} in stock.`,
      price,
      stock,
      lineItemsJson: JSON.stringify([
        {
          title: mapping.masterSku,
          quantity: 1,
          ...(price !== null ? { price } : {}),
        },
      ]),
      sku: mapping.masterSku,
      title: mapping.masterSku,
      score: overlap > 0 ? 0.8 + overlap * 0.2 : 0.1,
      source: 'catalog',
    });
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, Math.max(1, limit));
  if (top.length === 0) {
    // No match at all: return an explicit out-of-stock answer so the
    // template's stock check routes to the out-of-stock reply instead of
    // failing on an empty results array.
    return {
      results: [
        {
          answer:
            'Sorry, I could not find that product in the catalog. Please ask about another item.',
          price: null,
          stock: 0,
          lineItemsJson: '[]',
          sku: '',
          title: '',
          score: 0,
          source: 'catalog',
        },
      ],
    };
  }
  return { results: top };
}

export interface RagRouteDeps {
  rag: RagState;
  ops: OpsState;
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireOwner: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

function isLoopback(req: FastifyRequest): boolean {
  const ip = (req.ip ?? '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

export function registerRagRoutes(app: FastifyInstance, deps: RagRouteDeps): void {
  const { rag, ops, requireAuth, requireOwner } = deps;

  const requireAuthOrLoopback = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (isLoopback(req)) return;
    await requireAuth(req, reply);
  };

  app.post(
    '/api/rag/search',
    { preHandler: requireAuthOrLoopback },
    async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const query = typeof body.query === 'string' ? body.query : '';
      const limit =
        typeof body.limit === 'number' && body.limit > 0
          ? Math.min(10, Math.floor(body.limit))
          : 3;
      return searchRag(rag, ops, query, limit);
    },
  );

  app.post(
    '/api/rag/documents',
    { preHandler: [requireAuth, requireOwner] },
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.title !== 'string' || typeof body.content !== 'string') {
        await reply.code(400).send({ error: 'title and content are required' });
        return;
      }
      const doc = await addRagDocument(
        rag,
        {
          title: body.title,
          content: body.content,
          metadata:
            body.metadata && typeof body.metadata === 'object'
              ? (body.metadata as Record<string, unknown>)
              : {},
        },
        { userId: (req.authUser as { id: string }).id },
      );
      return { id: doc.id, title: doc.title };
    },
  );

  app.get(
    '/api/rag/documents',
    { preHandler: [requireAuth, requireOwner] },
    async () => ({
      documents: [...rag.documents.values()].map((d) => ({
        id: d.id,
        title: d.title,
        metadata: d.metadata ?? {},
      })),
    }),
  );
}
