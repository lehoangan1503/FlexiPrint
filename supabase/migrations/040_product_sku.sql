-- =====================================================
-- Customize Tool 040 — the product's SKU is its own field (asked 2026-11-24: "Tách SKU thành ô riêng, không nằm
-- trong tên … sku là sku, k liên quan đến title, handle shopify sẽ được lưu dạng handle từ title + sku ở đuôi")
--
-- ct_products.sku  n0x-POD-yyy in the standard form (customize-tool/lib/sku.ts normalizeSku), null = none yet.
-- Not unique in the DB: two old products already share one (the app refuses to save / deploy a twin,
-- server/sku-twins.ts). The SKUs read from the old names were copied in once by work/sku-backfill (2026-11-24).
--
-- Additive; run after 001–039. Re-runnable.
-- =====================================================

ALTER TABLE flexiprint.ct_products ADD COLUMN IF NOT EXISTS sku TEXT;
CREATE INDEX IF NOT EXISTS ct_products_sku_idx ON flexiprint.ct_products (sku) WHERE sku IS NOT NULL;
