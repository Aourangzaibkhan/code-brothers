-- 0014_products.sql
-- Local product catalog (spec §7.2): the merchant's own stock ledger.
-- Template-03 (3-channel stock sync) deducts local stock with
--   UPDATE products SET stock = stock - ? WHERE master_sku = ?
-- and the RAG catalog search reads this table's rows through the
-- SKU mappings; without it the local leg of the sync has no table.
-- user_id is the owning merchant (same pattern as sku_mappings).

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  master_sku  text NOT NULL,
  title       text,
  stock       integer NOT NULL DEFAULT 0,
  price       numeric(12, 2),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_products_user_sku ON products (user_id, master_sku);
CREATE INDEX idx_products_user ON products (user_id);
