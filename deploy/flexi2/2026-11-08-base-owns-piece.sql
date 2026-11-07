-- =====================================================
-- flexi2 data, 2026-11-08 — the product base owns the physical piece (khuôn, cut, phôi), the artwork only the design
-- (lib/base-fit.ts). Run ONCE on flexi2 after the deploy of that commit; the VPS instance never ran 031 and skips it.
--
--   1. Every artwork is viewed on a base (base_product_id): the base of its khuôn when it was made on one, else of
--      its material. Artworks of no base kind (kitchen mat, birth-flower prints…) stay without.
--   2. A khuôn layer an artwork / product carries that IS its base's khuôn at the same size (made on it before) goes:
--      the base lays it again (products: re-laid by saving each base — server applyBase).
-- =====================================================

BEGIN;
SET search_path TO flexiprint, public;

-- ---- 1. artworks → the base they are viewed on ----
UPDATE ct_products p SET base_product_id = b.id
FROM ct_base_products b
WHERE p.kind = 'artwork' AND p.base_product_id IS NULL
  AND b.config->>'templateId' = p.config->'print'->>'templateId';

UPDATE ct_products p SET base_product_id = b.id
FROM ct_base_products b
WHERE p.kind = 'artwork' AND p.base_product_id IS NULL
  AND b.config->>'material' = CASE
    WHEN p.config->'material'->>'id' LIKE 'acrylic%' THEN 'acrylic_clear'
    WHEN p.config->'material'->>'id' LIKE 'glass%' THEN 'glass_clear'
    WHEN p.config->'material'->>'id' LIKE 'ceramic%' THEN 'ceramic_gloss'
    ELSE '-' END;

-- ---- 2. own khuôn layers that are the base's khuôn, same sheet size ----
DELETE FROM ct_regions r
USING ct_products p, ct_base_products b, ct_print_templates t, ct_assets a
WHERE r.product_id = p.id
  AND (r.config->>'materialFrame')::boolean
  AND b.id = p.base_product_id
  AND t.id = (b.config->>'templateId')::uuid
  AND p.config->'print'->>'templateId' = t.id::text
  AND a.id = p.main_asset_id
  AND a.width = (t.spec->>'width')::int AND a.height = (t.spec->>'height')::int;

COMMIT;
