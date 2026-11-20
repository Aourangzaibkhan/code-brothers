-- 0013_polling_state.sql
-- Spec §9: polling_state — last checked timestamps/cursors for Daraz
-- & YouTube triggers, so pollers resume where they left off and never
-- re-process (or miss) items across restarts.

CREATE TABLE polling_state (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source                text NOT NULL CHECK (source IN ('daraz', 'youtube')),
  account_ref           text NOT NULL DEFAULT '', -- seller id / channel id the cursor belongs to
  cursor                text,                     -- opaque provider cursor / page token
  last_seen_external_id text,                     -- newest order/video id already processed
  last_checked_at       timestamptz,
  state                 jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, account_ref)
);
