-- 0004_webhooks.sql
-- Spec §9: webhooks — dynamic slug-to-workflow registry, HMAC secrets,
-- IP allowlists, replay nonce cache (webhook_replay_nonces).

CREATE TABLE webhooks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id           uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  slug                  text NOT NULL UNIQUE, -- public path segment that routes to the workflow
  hmac_secret_encrypted text NOT NULL,        -- envelope-encrypted HMAC signing secret
  ip_allowlist          text[] NOT NULL DEFAULT '{}', -- CIDR strings; empty array = allow all
  is_active             boolean NOT NULL DEFAULT true,
  last_triggered_at     timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhooks_workflow_id ON webhooks (workflow_id);

-- Replay protection: every accepted webhook nonce is recorded once;
-- a second delivery with the same nonce for the same webhook is rejected
-- by the UNIQUE constraint. Old rows are pruned by a scheduled cleanup.
CREATE TABLE webhook_replay_nonces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  nonce      text NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_id, nonce)
);
