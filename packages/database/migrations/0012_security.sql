-- 0012_security.sql
-- Spec §9: security_audit_logs & ip_bans — immutable security audit
-- trail, failed login tracking, and brute-force blocklist.
-- security_audit_logs is append-only by design: it has no updated_at
-- column and rows are never updated or deleted by the application.

CREATE TABLE security_audit_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES users (id) ON DELETE SET NULL, -- null for anonymous events (e.g. failed login)
  event_type text NOT NULL, -- login_failed | login_success | 2fa_failed | kill_switch | vault_access | ...
  severity   text NOT NULL DEFAULT 'info'
               CHECK (severity IN ('info', 'warning', 'critical')),
  ip_address inet,
  user_agent text,
  details    jsonb NOT NULL DEFAULT '{}', -- redacted event details
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_security_audit_logs_event ON security_audit_logs (event_type, created_at);
CREATE INDEX idx_security_audit_logs_user ON security_audit_logs (user_id, created_at);

CREATE TABLE ip_bans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address      inet NOT NULL UNIQUE,
  reason          text,
  failed_attempts integer NOT NULL DEFAULT 0,
  banned_until    timestamptz, -- null = banned until manually lifted (while is_active)
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
