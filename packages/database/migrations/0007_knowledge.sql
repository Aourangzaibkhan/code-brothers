-- 0007_knowledge.sql
-- Spec §9: knowledge_documents & embeddings — uploaded docs, synced
-- catalogs, workspace-isolated pgvector embeddings.
-- The embeddings.embedding vector(1024) column itself lives in
-- 0008_embeddings_vector.sql so this base schema also runs on databases
-- (and test doubles) without the pgvector extension.

CREATE TABLE knowledge_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, -- isolation boundary for RAG search
  title        text NOT NULL,
  source_type  text NOT NULL DEFAULT 'upload'
                 CHECK (source_type IN ('upload', 'catalog_sync', 'url', 'manual')),
  source_ref   text, -- file name, catalog id or URL the document came from
  content      text, -- extracted plain text (may be null for very large docs)
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_documents_workspace ON knowledge_documents (workspace_id);
CREATE INDEX idx_knowledge_documents_user ON knowledge_documents (user_id);

CREATE TABLE embeddings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, -- denormalized from the document for isolated vector search
  chunk_index  integer NOT NULL,
  content      text NOT NULL, -- the chunk text the embedding represents
  token_count  integer,
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX idx_embeddings_workspace ON embeddings (workspace_id);
CREATE INDEX idx_embeddings_document ON embeddings (document_id);
