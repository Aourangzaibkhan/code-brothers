-- 0011_customers_payments.sql
-- Spec §9: customers_crm & payment_tids — cross-channel Customer 360,
-- preferred language, COD risk scores, verified payment TID ledger.
-- payment_tids.tid is globally UNIQUE: that constraint is the duplicate
-- payment shield — the same transaction id can never be verified twice.

CREATE TABLE customers_crm (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, -- owning merchant
  name               text,
  phone              text,
  email              text,
  preferred_language text NOT NULL DEFAULT 'en',
  cod_risk_score     numeric(5, 2) NOT NULL DEFAULT 0, -- 0 = trusted, higher = riskier
  cod_orders_count   integer NOT NULL DEFAULT 0,
  cod_refusals_count integer NOT NULL DEFAULT 0, -- refused/returned COD parcels
  total_orders       integer NOT NULL DEFAULT 0,
  total_spent        numeric(12, 2) NOT NULL DEFAULT 0,
  channel_refs       jsonb NOT NULL DEFAULT '{}', -- {"shopify": "...", "daraz": "...", "whatsapp": "..."}
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_customers_crm_phone ON customers_crm (user_id, phone);
CREATE UNIQUE INDEX uq_customers_crm_email ON customers_crm (user_id, email);
CREATE INDEX idx_customers_crm_user ON customers_crm (user_id);

CREATE TABLE payment_tids (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, -- owning merchant
  tid         text NOT NULL UNIQUE, -- JazzCash/EasyPaisa/bank/UPI/PIX transaction id
  provider    text NOT NULL DEFAULT 'bank'
                CHECK (provider IN ('jazzcash', 'easypaisa', 'bank', 'upi', 'pix', 'other')),
  amount      numeric(12, 2) NOT NULL,
  currency    text NOT NULL DEFAULT 'PKR',
  order_ref   text, -- store order number this payment claims to settle
  customer_id uuid REFERENCES customers_crm (id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'verified'
                CHECK (status IN ('pending', 'verified', 'rejected', 'duplicate')),
  verified_at timestamptz,
  metadata    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_tids_user ON payment_tids (user_id);
CREATE INDEX idx_payment_tids_order ON payment_tids (order_ref);
