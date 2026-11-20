/**
 * Ingestion + retrieval pipeline (spec §4D): documents are chunked,
 * embedded and stored under their workspace; queries are embedded and
 * searched ONLY inside the caller's workspace.
 */

import { chunkDocument, type ChunkOptions, type DocumentInput } from './chunker.js';
import type { Embedder } from './embeddings.js';
import type { SearchHit, StoredChunk, VectorStore } from './store.js';

export interface IngestResult {
  docId: string;
  workspaceId: string;
  chunkCount: number;
  chunkIds: string[];
}

export async function ingestDocument(
  store: VectorStore,
  embedder: Embedder,
  doc: DocumentInput,
  chunkOpts: ChunkOptions = {},
): Promise<IngestResult> {
  const chunks = chunkDocument(doc, chunkOpts);
  if (chunks.length === 0) {
    return { docId: doc.id, workspaceId: doc.workspaceId, chunkCount: 0, chunkIds: [] };
  }
  const vectors = await embedder.embed(chunks.map((c) => c.text));
  const stored: StoredChunk[] = chunks.map((chunk, i) => ({
    ...chunk,
    embedding: vectors[i]!,
  }));
  await store.add(stored);
  return {
    docId: doc.id,
    workspaceId: doc.workspaceId,
    chunkCount: stored.length,
    chunkIds: stored.map((c) => c.id),
  };
}

export async function search(
  store: VectorStore,
  embedder: Embedder,
  workspaceId: string,
  query: string,
  k = 5,
): Promise<SearchHit[]> {
  const [queryVector] = await embedder.embed([query]);
  if (!queryVector) return [];
  return store.search(workspaceId, queryVector, k);
}
