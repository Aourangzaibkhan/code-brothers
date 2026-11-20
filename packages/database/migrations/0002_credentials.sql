-- 0002_credentials.sql
-- Spec §9: credentials — AES-256-GCM envelope-encrypted API keys and OAuth
-- tokens, IVs, DEKs, rotation metadata. Plaintext secrets are never stored:
-- the payload is encrypted with a per-credential data-encryption key (DEK),
-- and the DEK itself is stored wrapped by the platform key-encryption key.

CREATE TABLE credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider        text NOT NULL, -- shopify | daraz | whatsapp | youtube | gemini | groq | ...
  name            text NOT NULL, -- human label, unique per (user, provider)
  kind            text NOT NULL DEFAULT 'api_key'
                    CHECK (kind IN ('api_key', 'oauth', 'basic', 'custom')),
  ciphertext      bytea NOT NULL, -- AES-256-GCM ciphertext of the secret payload
  iv              bytea NOT NULL, -- GCM nonce used for the payload
  auth_tag        bytea,          -- GCM authentication tag for the payload
  dek_wrapped     bytea NOT NULL, -- DEK wrapped (encrypted) by the KEK — envelope encryption
  dek_iv          bytea NOT NULL, -- nonce used when wrapping the DEK
  key_version     integer NOT NULL DEFAULT 1,
  expires_at      timestamptz,    -- e.g. OAuth token expiry
  last_rotated_at timestamptz,
  rotation_due_at timestamptz,
  metadata        jsonb NOT NULL DEFAULT '{}', -- non-secret hints (scopes, account id, ...)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, name)
);

CREATE INDEX idx_credentials_user_provider ON credentials (user_id, provider);
