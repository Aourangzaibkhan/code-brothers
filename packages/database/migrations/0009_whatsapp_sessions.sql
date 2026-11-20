-- 0009_whatsapp_sessions.sql
-- Spec §9: whatsapp_sessions — multi-number encrypted QR session states
-- & daily anti-ban counters.

CREATE TABLE whatsapp_sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  phone_number            text NOT NULL,
  engine                  text NOT NULL DEFAULT 'qr'
                            CHECK (engine IN ('qr', 'cloud_api')),
  status                  text NOT NULL DEFAULT 'disconnected'
                            CHECK (status IN ('disconnected', 'connecting', 'connected', 'banned')),
  session_state_encrypted bytea, -- envelope-encrypted QR session state; never stored in plaintext
  messages_sent_today     integer NOT NULL DEFAULT 0, -- anti-ban daily counter
  counter_date            date NOT NULL DEFAULT CURRENT_DATE, -- day the counter belongs to
  last_connected_at       timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone_number)
);
