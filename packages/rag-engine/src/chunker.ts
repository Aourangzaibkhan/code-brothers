/**
 * Document chunker (spec §4D — RAG knowledge base ingestion).
 *
 * Splits text / markdown / CSV documents into overlapping chunks that keep
 * their provenance: every chunk carries docId, workspaceId and chunkIndex
 * so vector search results can always be traced back — and isolated — per
 * workspace.
 */

export type DocumentType = 'text' | 'markdown' | 'csv';

export interface DocumentInput {
  id: string;
  workspaceId: string;
  text: string;
  type?: DocumentType;
  metadata?: Record<string, unknown>;
}

export interface Chunk {
  id: string;
  docId: string;
  workspaceId: string;
  chunkIndex: number;
  text: string;
  metadata: Record<string, unknown>;
}

export interface ChunkOptions {
  /** Max characters per chunk. Default 1000. */
  chunkSize?: number;
  /** Characters shared between consecutive chunks. Default 150. */
  overlap?: number;
}

/**
 * Split raw text into overlapping character windows. The window start
 * advances by (chunkSize - overlap), so consecutive chunks share exactly
 * `overlap` characters (except possibly the final chunk).
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const chunkSize = opts.chunkSize ?? 1000;
  const overlap = opts.overlap ?? 150;
  if (chunkSize < 1) throw new Error('chunkSize must be at least 1');
  if (overlap < 0 || overlap >= chunkSize) {
    throw new Error('overlap must be >= 0 and smaller than chunkSize');
  }
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= chunkSize) return [clean];
  const step = chunkSize - overlap;
  const chunks: string[] = [];
  for (let start = 0; start < clean.length; start += step) {
    const piece = clean.slice(start, start + chunkSize);
    if (piece.trim()) chunks.push(piece);
    if (start + chunkSize >= clean.length) break;
  }
  return chunks;
}

/**
 * CSV documents chunk by row: the header line is prepended to every chunk
 * so each row stays self-describing ("sku,name,price" context is never
 * lost), and rows are packed up to chunkSize characters.
 */
export function chunkCsv(text: string, opts: ChunkOptions = {}): string[] {
  const chunkSize = opts.chunkSize ?? 1000;
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const [header, ...rows] = lines as [string, ...string[]];
  if (rows.length === 0) return [header];
  const chunks: string[] = [];
  let current = header;
  for (const row of rows) {
    const candidate = `${current}\n${row}`;
    if (candidate.length > chunkSize && current !== header) {
      chunks.push(current);
      current = `${header}\n${row}`;
    } else {
      current = candidate;
    }
  }
  if (current !== header) chunks.push(current);
  return chunks;
}

/** Chunk a full document, stamping workspace/doc provenance on each chunk. */
export function chunkDocument(doc: DocumentInput, opts: ChunkOptions = {}): Chunk[] {
  const type = doc.type ?? 'text';
  const pieces =
    type === 'csv' ? chunkCsv(doc.text, opts) : chunkText(doc.text, opts);
  return pieces.map((text, i) => ({
    id: `${doc.id}#${i}`,
    docId: doc.id,
    workspaceId: doc.workspaceId,
    chunkIndex: i,
    text,
    metadata: { ...(doc.metadata ?? {}), type },
  }));
}
