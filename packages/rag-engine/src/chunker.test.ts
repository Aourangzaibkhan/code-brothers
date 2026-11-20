import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkCsv, chunkDocument, chunkText } from './index.js';

test('chunkText produces exact overlaps between consecutive chunks', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(10); // 260 chars
  const chunks = chunkText(text, { chunkSize: 50, overlap: 10 });
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) assert.ok(chunk.length <= 50);
  for (let i = 1; i < chunks.length; i++) {
    const prevTail = chunks[i - 1]!.slice(-10);
    const head = chunks[i]!.slice(0, 10);
    assert.equal(head, prevTail, `chunk ${i} must start with the last 10 chars of chunk ${i - 1}`);
  }
  // Windows advance by chunkSize - overlap = 40 chars.
  assert.equal(chunks[1], text.slice(40, 90));
});

test('chunkText validates options and handles short/empty text', () => {
  assert.deepEqual(chunkText('hello', { chunkSize: 50, overlap: 10 }), ['hello']);
  assert.deepEqual(chunkText('   ', { chunkSize: 50, overlap: 10 }), []);
  assert.throws(() => chunkText('x'.repeat(100), { chunkSize: 10, overlap: 10 }), /overlap/);
  assert.throws(() => chunkText('x'.repeat(100), { chunkSize: 0 }), /chunkSize/);
});

test('chunkDocument stamps doc/workspace provenance and sequential indexes', () => {
  const chunks = chunkDocument(
    { id: 'doc-1', workspaceId: 'ws-a', text: 'word '.repeat(100), metadata: { source: 'faq' } },
    { chunkSize: 60, overlap: 10 },
  );
  assert.ok(chunks.length > 1);
  chunks.forEach((chunk, i) => {
    assert.equal(chunk.docId, 'doc-1');
    assert.equal(chunk.workspaceId, 'ws-a');
    assert.equal(chunk.chunkIndex, i);
    assert.equal(chunk.id, `doc-1#${i}`);
    assert.equal(chunk.metadata.source, 'faq');
    assert.equal(chunk.metadata.type, 'text');
  });
});

test('chunkCsv keeps the header on every chunk and packs rows', () => {
  const csv = [
    'sku,name,price',
    'K-1,Blue Kurti,1499',
    'K-2,Red Kurti,1799',
    'K-3,Green Kurti,1999',
    'K-4,Black Kurti,2199',
  ].join('\n');
  const chunks = chunkCsv(csv, { chunkSize: 60 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.startsWith('sku,name,price'), 'every CSV chunk carries the header');
    assert.ok(chunk.length <= 60 + 'K-4,Black Kurti,2199'.length);
  }
  const allText = chunks.join('\n');
  for (const sku of ['K-1', 'K-2', 'K-3', 'K-4']) {
    assert.ok(allText.includes(sku), `row ${sku} present in some chunk`);
  }
});
