-- 0008_embeddings_vector.sql
-- pgvector support for embeddings — kept in its own migration because it
-- requires the pgvector extension, which is unavailable in some
-- environments (e.g. the pg-mem test double). On a real PostgreSQL
-- (pgvector/pgvector:pg16, see docker/) this applies like any other file.
-- Embedding dimension 1024 matches the spec's multilingual model bge-m3.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- Approximate nearest-neighbour index for cosine similarity search.
CREATE INDEX IF NOT EXISTS idx_embeddings_embedding
  ON embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
