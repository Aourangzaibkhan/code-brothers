-- 0003_workflows.sql
-- Spec §9: workflows & workflow_versions — saved JSON DAG graphs
-- (nodes, edges, settings, is_active) with full revision history.

CREATE TABLE workflows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  nodes           jsonb NOT NULL DEFAULT '[]', -- DAG nodes (React Flow graph)
  edges           jsonb NOT NULL DEFAULT '[]', -- DAG edges
  settings        jsonb NOT NULL DEFAULT '{}',
  is_active       boolean NOT NULL DEFAULT false,
  current_version integer NOT NULL DEFAULT 1,
  tags            text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflows_user_id ON workflows (user_id);

CREATE TABLE workflow_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  version     integer NOT NULL,
  nodes       jsonb NOT NULL DEFAULT '[]',
  edges       jsonb NOT NULL DEFAULT '[]',
  settings    jsonb NOT NULL DEFAULT '{}',
  comment     text, -- revision note
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

CREATE INDEX idx_workflow_versions_workflow ON workflow_versions (workflow_id);
