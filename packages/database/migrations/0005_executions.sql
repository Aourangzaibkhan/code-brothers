-- 0005_executions.sql
-- Spec §9: executions & execution_steps — redacted run history with
-- node-level inputs/outputs, durations and errors. Inputs/outputs must be
-- passed through the secret redactor before they are stored here.

CREATE TABLE executions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id      uuid REFERENCES workflows (id) ON DELETE SET NULL, -- history survives workflow deletion
  workflow_version integer,
  status           text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'success', 'failed', 'cancelled')),
  trigger_type     text NOT NULL DEFAULT 'manual', -- manual | webhook | cron | polling | retry
  input            jsonb NOT NULL DEFAULT '{}',    -- redacted
  output           jsonb,                          -- redacted
  error            text,
  started_at       timestamptz,
  finished_at      timestamptz,
  duration_ms      integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_executions_workflow ON executions (workflow_id, created_at);
CREATE INDEX idx_executions_status ON executions (status);

CREATE TABLE execution_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
  node_id      text NOT NULL, -- node id inside the workflow graph
  node_type    text,
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'success', 'failed', 'skipped', 'cancelled')),
  input        jsonb, -- redacted
  output       jsonb, -- redacted
  error        text,
  attempt      integer NOT NULL DEFAULT 1,
  started_at   timestamptz,
  finished_at  timestamptz,
  duration_ms  integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_execution_steps_execution ON execution_steps (execution_id);
