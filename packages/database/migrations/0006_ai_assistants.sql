-- 0006_ai_assistants.sql
-- Spec §9: ai_assistants & ai_memories — custom assistant personas, tool
-- whitelists, per-user chat history & summaries.

CREATE TABLE ai_assistants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name           text NOT NULL,
  persona        text, -- system prompt / persona definition
  model          text, -- preferred model id; the hybrid router may fall back
  tool_whitelist text[] NOT NULL DEFAULT '{}', -- least-privilege tool access
  settings       jsonb NOT NULL DEFAULT '{}',
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE ai_memories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  assistant_id uuid REFERENCES ai_assistants (id) ON DELETE SET NULL,
  role         text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'summary')),
  content      text NOT NULL,
  is_summary   boolean NOT NULL DEFAULT false, -- true for compacted conversation summaries
  token_count  integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_memories_user_created ON ai_memories (user_id, created_at);
CREATE INDEX idx_ai_memories_assistant ON ai_memories (assistant_id, created_at);
