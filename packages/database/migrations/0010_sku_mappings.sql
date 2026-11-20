-- 0010_sku_mappings.sql
-- Spec §9: sku_mappings — unified inventory link across Shopify, Daraz,
-- and Local Websites. One master SKU maps to at most one SKU per channel
-- per merchant; channel SKUs are unique per merchant when present
-- (PostgreSQL unique indexes treat NULLs as distinct, so unmapped
-- channels never collide).

CREATE TABLE sku_mappings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, -- owning merchant
  master_sku        text NOT NULL,
  shopify_sku       text,
  shopify_product_id text,
  daraz_sku         text,
  daraz_item_id     text,
  local_sku         text,
  local_product_id  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, master_sku)
);

CREATE UNIQUE INDEX uq_sku_mappings_shopify ON sku_mappings (user_id, shopify_sku);
CREATE UNIQUE INDEX uq_sku_mappings_daraz ON sku_mappings (user_id, daraz_sku);
CREATE UNIQUE INDEX uq_sku_mappings_local ON sku_mappings (user_id, local_sku);
