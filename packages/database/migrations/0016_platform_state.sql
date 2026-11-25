-- 0016_platform_state.sql
-- Spec §8: platform kill switch ("Freeze Platform") as a durable
-- single-row table instead of process memory, so the freeze survives an
-- API restart AND is visible to the worker process (which runs in a
-- separate container and must refuse runs while the platform is halted).

CREATE TABLE platform_state (
  id         text PRIMARY KEY DEFAULT 'platform',
  halted     boolean NOT NULL DEFAULT false,
  halted_at  timestamptz,
  halted_by  text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_state (id, halted) VALUES ('platform', false)
ON CONFLICT (id) DO NOTHING;
