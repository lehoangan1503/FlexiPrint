-- =====================================================
-- Customize Tool — biến thể thuộc product base, bảng giá chỉ giữ giá (2026-11-24)
--
-- Before: a price table was Size × Pack ({sizeLabel, sizes: [{id,label,price,compareAt}], packs, overrides}); two
-- kinds of one product were glued into the size label ("30 x 40 inches - Fleece") → 6 buttons in one row on Shopify.
-- Now (lib/pricing.ts):
--   ct_base_products.config.options  [{id, name, values[]}]  — the Shopify option rows (Material × Size …)
--   ct_price_tables.config           {optionNames, rows: [{id, values[], price, compareAt}], packs, packLabel,
--                                     itemLabel, overrides "<rowId>:<packId>"}  — prices only
-- A size becomes a row of one value (its id is kept, so the overrides still point at it); a table with one unnamed
-- size becomes one row of no value. Each base takes its table's sizes as one option. The app also reads the old shape
-- (normalizePriceTableConfig), so this can run before or after the new app.
--
-- Data: the "Fleece & Sherpa Blanket" table is split into Material × Size the way its 49 Shopify products were fixed
-- by hand (Material: Plush Blanket | Sherpa Blanket, Size: 3) — only while it still has the glued labels.
--
-- Idempotent; run after 001–038.
-- =====================================================

SET search_path TO flexiprint, public;

-- 1. Price tables: sizes → rows.
UPDATE flexiprint.ct_price_tables t
SET config = (t.config - 'sizes' - 'sizeLabel') || jsonb_build_object(
  'optionNames', CASE WHEN x.named THEN jsonb_build_array(COALESCE(NULLIF(t.config->>'sizeLabel', ''), 'Size')) ELSE '[]'::jsonb END,
  'rows', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s->>'id',
      'values', CASE WHEN x.named THEN jsonb_build_array(s->>'label') ELSE '[]'::jsonb END,
      'price', s->'price',
      'compareAt', s->'compareAt') ORDER BY o)
    FROM jsonb_array_elements(t.config->'sizes') WITH ORDINALITY e(s, o)
    WHERE x.named OR o = 1
  ), '[]'::jsonb))
FROM (
  SELECT id, (jsonb_array_length(config->'sizes') > 1 OR COALESCE(config->'sizes'->0->>'label', '') <> '') AS named
  FROM flexiprint.ct_price_tables
  WHERE config ? 'sizes' AND jsonb_typeof(config->'sizes') = 'array'
) x
WHERE x.id = t.id AND NOT (t.config ? 'rows');

-- 2. Fleece & Sherpa Blanket: "30 x 40 inches - Fleece" → ["Plush Blanket", "30 x 40 inches"].
UPDATE flexiprint.ct_price_tables t
SET config = t.config || jsonb_build_object(
  'optionNames', '["Material", "Size"]'::jsonb,
  'rows', (
    SELECT jsonb_agg(jsonb_build_object(
      'id', r->>'id',
      'values', jsonb_build_array(
        CASE WHEN r->'values'->>0 ILIKE '% - Fleece' THEN 'Plush Blanket' ELSE 'Sherpa Blanket' END,
        regexp_replace(r->'values'->>0, '\s*-\s*(Fleece|Sherpa)$', '', 'i')),
      'price', r->'price',
      'compareAt', r->'compareAt') ORDER BY o)
    FROM jsonb_array_elements(t.config->'rows') WITH ORDINALITY e(r, o)))
WHERE t.id = '56f18219-cff1-43b4-ba8b-fdd89c8b2f23'
  AND t.config->'rows'->0->'values'->>0 ~* ' - (Fleece|Sherpa)$';

-- 3. Bases: their table's values become their options (only bases with no options yet).
UPDATE flexiprint.ct_base_products b
SET config = b.config || jsonb_build_object('options', COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'id', gen_random_uuid()::text,
    'name', COALESCE(NULLIF(t.config->'optionNames'->>(i - 1)::int, ''), 'Size'),
    'values', (
      SELECT jsonb_agg(v ORDER BY first_o)
      FROM (
        SELECT r->'values'->>(i - 1)::int AS v, MIN(o) AS first_o
        FROM jsonb_array_elements(t.config->'rows') WITH ORDINALITY e(r, o)
        WHERE COALESCE(r->'values'->>(i - 1)::int, '') <> ''
        GROUP BY 1
      ) vals)) ORDER BY i)
  FROM generate_series(1, jsonb_array_length(COALESCE(t.config->'optionNames', '[]'::jsonb))) i
), '[]'::jsonb))
FROM flexiprint.ct_price_tables t
WHERE t.id::text = b.config->>'priceTableId' AND NOT (b.config ? 'options');

NOTIFY pgrst, 'reload schema';
