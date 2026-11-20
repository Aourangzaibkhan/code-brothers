-- 0001_users_sessions.sql
-- Spec §9: users & sessions — accounts (Argon2id hashes), TOTP 2FA secrets,
-- preferred locale, RBAC roles, active devices.
-- Note: updated_at is maintained by the application layer (the spec's ORM
-- direction is Drizzle/Prisma, which do this in code); it defaults to now()
-- on insert. gen_random_uuid() is built into PostgreSQL 13+, no extension needed.

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL UNIQUE,
  password_hash         text NOT NULL, -- Argon2id hash, never a plaintext password
  display_name          text,
  role                  text NOT NULL DEFAULT 'member'
                          CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  locale                text NOT NULL DEFAULT 'en', -- en, ur, ar, hi, pt-BR, ...
  totp_secret_encrypted text, -- envelope-encrypted TOTP secret (see credentials vault)
  totp_enabled          boolean NOT NULL DEFAULT false,
  is_active             boolean NOT NULL DEFAULT true,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE, -- hash of the session token, never the raw token
  device_name  text,
  user_agent   text,
  ip_address   inet,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user_id ON sessions (user_id);
