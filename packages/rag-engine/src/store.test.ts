import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HashEmbedder,
  InMemoryVectorStore,
  OllamaEmbedder,
  PgVectorStore,
  cosineSimilarity,
  ingestDocument,
  search,
  toVectorLiteral,
  type FetchLike,
} from './index.js';

test('HashEmbedder is deterministic and self-similar', async () => {
  const embedder = new HashEmbedder(32);
  const [a1] = await embedder.embed(['blue kurti price']);
  const [a2] = await embedder.embed(['blue kurti price']);
  assert.deepEqual(a1, a2);
  assert.equal(a1!.length, 32);
  assert.ok(Math.abs(cosineSimilarity(a1!, a1!) - 1) < 1e-9);
  const [related] = await embedder.embed(['blue kurti size chart']);
  const [unrelated] = await embedder.embed(['tractor engine piston ring']);
  assert.ok(cosineSimilarity(a1!, related!) > cosineSimilarity(a1!, unrelated!));
});

test('OllamaEmbedder calls /api/embeddings with the bge-m3 shape', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const embedder = new OllamaEmbedder({ fetch: fetchFn });
  const vectors = await embedder.embed(['hello', 'world']);
  assert.deepEqual(vectors, [
    [0.1, 0.2, 0.3],
    [0.1, 0.2, 0.3],
  ]);
  assert.equal(calls[0]!.url, 'http://localhost:11434/api/embeddings');
  assert.deepEqual(calls[0]!.body, { model: 'bge-m3', prompt: 'hello' });
});

test('workspace isolation: a search in workspace A never returns workspace B chunks', async () => {
  const embedder = new HashEmbedder(64);
  const store = new InMemoryVectorStore();
  // Near-identical text in both workspaces — isolation must come from the
  // workspace filter, not from relevance.
  await ingestDocument(store, embedder, {
    id: 'a-secret',
    workspaceId: 'ws-a',
    text: 'refund policy workspace a: full refund within 14 days no questions asked',
  });
  await ingestDocument(store, embedder, {
    id: 'b-secret',
    workspaceId: 'ws-b',
    text: 'refund policy workspace b: full refund within 14 days no questions asked',
  });
  assert.equal(await store.count(), 2);

  const hitsA = await search(store, embedder, 'ws-a', 'refund policy full refund 14 days', 10);
  assert.ok(hitsA.length > 0);
  for (const hit of hitsA) {
    assert.equal(hit.chunk.workspaceId, 'ws-a');
    assert.notEqual(hit.chunk.docId, 'b-secret');
  }
  const hitsB = await search(store, embedder, 'ws-b', 'refund policy full refund 14 days', 10);
  assert.ok(hitsB.length > 0);
  for (const hit of hitsB) {
    assert.equal(hit.chunk.workspaceId, 'ws-b');
  }
  const hitsNone = await search(store, embedder, 'ws-empty', 'refund policy', 10);
  assert.deepEqual(hitsNone, []);
});

test('ingest + search round-trip finds the relevant chunk first', async () => {
  const embedder = new HashEmbedder(64);
  const store = new InMemoryVectorStore();
  await ingestDocument(store, embedder, {
    id: 'catalog',
    workspaceId: 'shop-1',
    type: 'csv',
    text: 'sku,name,price\nK-1,Blue Kurti,1499\nS-9,Leather Sandals,2499',
  });
  await ingestDocument(store, embedder, {
    id: 'faq',
    workspaceId: 'shop-1',
    text: 'Delivery takes 3 to 5 working days across Pakistan. Cash on delivery is available.',
  });
  const hits = await search(store, embedder, 'shop-1', 'blue kurti price', 2);
  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.chunk.docId, 'catalog');
  assert.ok(hits[0]!.score > 0);
});

test('PgVectorStore generates parameterized INSERT with a vector literal', () => {
  const stmt = PgVectorStore.buildInsert({
    id: 'doc#0',
    docId: 'doc',
    workspaceId: 'ws-a',
    chunkIndex: 0,
    text: 'hello',
    metadata: { source: 'faq' },
    embedding: [0.5, -0.25],
  });
  assert.match(stmt.sql, /INSERT INTO embeddings/);
  assert.match(stmt.sql, /\$1, \$2, \$3, \$4, \$5, \$6::jsonb, \$7::vector/);
  assert.ok(!stmt.sql.includes('hello'), 'content must be a parameter, never inlined');
  assert.equal(stmt.params.length, 7);
  assert.equal(stmt.params[1], 'ws-a');
  assert.equal(stmt.params[6], '[0.5,-0.25]');
  assert.equal(toVectorLiteral([1, 2]), '[1,2]');
});

test('PgVectorStore search SQL is workspace-scoped and uses the <=> operator', () => {
  const stmt = PgVectorStore.buildSearch('ws-a', [0.1, 0.2], 5);
  assert.match(stmt.sql, /FROM embeddings/);
  assert.match(stmt.sql, /WHERE workspace_id = \$2/);
  assert.match(stmt.sql, /ORDER BY embedding <=> \$1::vector/);
  assert.match(stmt.sql, /LIMIT \$3/);
  assert.deepEqual(stmt.params, ['[0.1,0.2]', 'ws-a', 5]);
});

test('PgVectorStore runs statements through the injected executor', async () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const store = new PgVectorStore(async (sql, params) => {
    seen.push({ sql, params });
    if (sql.startsWith('SELECT id')) {
      return {
        rows: [
          {
            id: 'doc#0',
            workspace_id: 'ws-a',
            document_id: 'doc',
            chunk_index: 0,
            content: 'hello',
            metadata: { source: 'faq' },
            score: 0.87,
          },
        ],
      };
    }
    return { rows: [] };
  });
  await store.add([
    {
      id: 'doc#0',
      docId: 'doc',
      workspaceId: 'ws-a',
      chunkIndex: 0,
      text: 'hello',
      metadata: {},
      embedding: [0.1],
    },
  ]);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.sql, /INSERT INTO embeddings/);
  const hits = await store.search('ws-a', [0.1], 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.chunk.text, 'hello');
  assert.equal(hits[0]!.score, 0.87);
});
