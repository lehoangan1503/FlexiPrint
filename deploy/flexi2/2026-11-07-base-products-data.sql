-- =====================================================
-- flexi2 data, 2026-11-07 — Product base · Artwork · Sản phẩm (run ONCE on flexi2, after 031_base_products.sql;
-- the VPS instance has other data and never ran it).
--
--   1. 4 product bases = the Notion price page (Glass Ornament 1 side, Ceramic Ornament 2 sides, Acrylic Ornament
--      1 side, Poseable Doll), each with its Notion price table and the khuôn in of its piece.
--   2. Every product already on Shopify is split: a NEW artwork row takes its design (layers + items copied with new
--      ids, its pictures, its set), the old row becomes the product (kind 'product', its base, a snapshot link to
--      the artwork keyed on its own layer ids) and keeps its Shopify link, templates and mockups.
--   3. Khuôn in: only the ones of the bases stay (the user: "chỉ giữ lại phôi và khuôn in đủ bằng với số lượng loại
--      sản phẩm trong notion giá"); the matching-phôi ceramic khuôn gives its phôi to the kept ceramic one first.
--      Artworks keep their own copy of a deleted khuôn (config.print).
-- Everything else stays an artwork (kind default).
-- =====================================================

BEGIN;
SET search_path TO flexiprint, public;

-- ---- 1. product bases ----
INSERT INTO ct_base_products (user_id, name, sort_order, config)
SELECT 'ac3f2384-08a5-4710-8439-6354bcbf2775', v.name, v.ord, jsonb_build_object(
  'description', '',
  'productType', v.ptype,
  'material', v.material,
  'priceTableId', v.price,
  'templateId', v.tpl,
  'printAreas', v.areas,
  'fulfillment', jsonb_build_object('provider', v.provider, 'catalogId', v.catalog),
  'notes', v.notes)
FROM (VALUES
  ('Acrylic Ornament 1 side', 1, 'Acrylic Ornament', 'acrylic_clear', 'faf435b0-88ee-4905-acf7-840ffd206359'::text, '6daa6f63-1de9-495b-a93b-46aa94e6a47d'::text,
   '[{"id":"front","name":"Front","width":1181,"height":1181,"dpi":300}]'::jsonb, 'Merchize', 'ACORUS',
   'Notion: 4"x4", 4.5"x4.5", 5.5"x5.5" × pack 1/2/3/4/5/10. Cắt theo viền hình (alpha) + silhouette.'),
  ('Glass Ornament 1 side', 2, 'Christmas Ornament', 'glass_clear', 'ad8212e1-ef16-427d-92af-e39d40cec49c', 'd83dd788-ed35-4db5-82cb-dc6efce792af',
   '[{"id":"front","name":"Front","width":999,"height":999,"dpi":300}]'::jsonb, 'Merchize', '',
   'Notion: Circle 3.0"x3.0" (có khuôn), Heart 3.15"x2.95" (chưa có khuôn). Made in US.'),
  ('Ceramic Ornament 2 sides', 3, 'Christmas Ornament', 'ceramic_gloss', 'ac5b39f8-0232-4a9c-bccd-06c157e99565', 'c7081689-b078-4d02-846a-d7952a8d6b2b',
   '[{"id":"front","name":"Front","width":1000,"height":1000,"dpi":300},{"id":"back","name":"Back","width":1000,"height":1000,"dpi":300}]'::jsonb, 'Merchize', '',
   'Notion: Circle 2.9"x2.9" (có khuôn), Heart 2.9"x3.1" và Star 3.14"x3.14" (chưa có khuôn). In 2 mặt. Made in US.'),
  ('Poseable Doll', 4, 'Poseable Plush Doll', 'none', '185378a9-e3bf-4387-b341-7305cf101f30', NULL,
   '[{"id":"artwork","name":"Artwork","width":4000,"height":1944,"dpi":300}]'::jsonb, 'Printbelle', '',
   'Notion: 8in / 10in / 12in. Print area theo Teeinblue (artwork 4000×1944).')
) AS v(name, ord, ptype, material, price, tpl, areas, provider, catalog, notes)
WHERE NOT EXISTS (SELECT 1 FROM ct_base_products b WHERE b.name = v.name);

-- ---- 2. split the products already on Shopify ----
CREATE TEMP TABLE m_ids (old uuid PRIMARY KEY, new uuid NOT NULL) ON COMMIT DROP;

CREATE FUNCTION pg_temp.remap(t text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE res text := t; u text; nu uuid;
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  FOR u IN SELECT DISTINCT (regexp_matches(t, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g'))[1] LOOP
    SELECT m.new INTO nu FROM m_ids m WHERE m.old = u::uuid;
    IF nu IS NOT NULL THEN res := replace(res, u, nu::text); END IF;
  END LOOP;
  RETURN res;
END $f$;

DO $$
DECLARE
  p record; a uuid; b uuid; rmap jsonb; imap jsonb; aids jsonb; mat text;
BEGIN
  FOR p IN SELECT * FROM flexiprint.ct_products WHERE shopify IS NOT NULL AND kind = 'artwork' ORDER BY created_at LOOP
    a := gen_random_uuid();
    mat := coalesce(p.config->'material'->>'id', '');
    SELECT id INTO b FROM flexiprint.ct_base_products
      WHERE config->>'material' = CASE WHEN mat LIKE 'acrylic%' THEN 'acrylic_clear' WHEN mat LIKE 'glass%' THEN 'glass_clear' WHEN mat LIKE 'ceramic%' THEN 'ceramic_gloss' ELSE '-' END
      LIMIT 1;
    TRUNCATE m_ids;
    INSERT INTO m_ids SELECT r.id, gen_random_uuid() FROM flexiprint.ct_regions r WHERE r.product_id = p.id;
    INSERT INTO m_ids SELECT it.id, gen_random_uuid() FROM flexiprint.ct_region_items it JOIN flexiprint.ct_regions r ON r.id = it.region_id WHERE r.product_id = p.id;

    -- the artwork: the design, ids moved to the copies
    INSERT INTO flexiprint.ct_products (id, user_id, name, status, main_asset_id, thumbnail_url, notes, config, kind, created_at)
    VALUES (a, p.user_id, p.name, p.status, p.main_asset_id, p.thumbnail_url, p.notes,
            pg_temp.remap(((p.config - 'artworkLink') || jsonb_build_object('artworkRevision', 1))::text)::jsonb, 'artwork', p.created_at - interval '1 second');
    INSERT INTO flexiprint.ct_regions (id, product_id, name, kind, shape, config, sort_order)
      SELECT m.new, a, r.name, r.kind, r.shape, pg_temp.remap(r.config::text)::jsonb, r.sort_order
      FROM flexiprint.ct_regions r JOIN m_ids m ON m.old = r.id WHERE r.product_id = p.id;
    INSERT INTO flexiprint.ct_region_items (id, region_id, asset_id, transform, is_default, sort_order)
      SELECT mi.new, mr.new, it.asset_id, it.transform, it.is_default, it.sort_order
      FROM flexiprint.ct_region_items it JOIN flexiprint.ct_regions r ON r.id = it.region_id
      JOIN m_ids mr ON mr.old = r.id JOIN m_ids mi ON mi.old = it.id
      WHERE r.product_id = p.id;
    INSERT INTO flexiprint.ct_product_mains (product_id, asset_id, sort_order)
      SELECT a, pm.asset_id, pm.sort_order FROM flexiprint.ct_product_mains pm WHERE pm.product_id = p.id;

    -- its pictures (not the mockups: they stay with the product)
    SELECT coalesce(jsonb_agg(id), '[]'::jsonb) INTO aids FROM flexiprint.ct_assets WHERE product_id = p.id AND role <> 'mockup';
    UPDATE flexiprint.ct_assets SET product_id = a WHERE product_id = p.id AND role <> 'mockup';
    UPDATE flexiprint.ct_assets SET meta = jsonb_set(meta, '{frame,productId}', to_jsonb(a::text))
      WHERE product_id = a AND meta->'frame'->>'productId' = p.id::text;
    UPDATE flexiprint.ct_assets SET meta = jsonb_set(meta, '{artwork,productId}', to_jsonb(a::text))
      WHERE product_id IS NULL AND meta->'artwork'->>'productId' = p.id::text;
    UPDATE flexiprint.ct_clipart_categories SET rules = jsonb_set(rules, '{productId}', to_jsonb(a::text))
      WHERE rules->>'productId' = p.id::text;

    -- its set now points at the artwork; an imported set remembers the product that went to Shopify
    UPDATE flexiprint.ct_char_projects SET product_ids = array_replace(product_ids, p.id, a) WHERE p.id = ANY(product_ids);
    UPDATE flexiprint.ct_char_projects SET brief = jsonb_set(brief, '{imported,productId}', to_jsonb(a::text))
      WHERE brief->'imported'->>'productId' = p.id::text;
    UPDATE flexiprint.ct_char_projects SET brief = jsonb_set(brief, '{imported,shopify,productId}', to_jsonb(p.id::text))
      WHERE a = ANY(product_ids) AND brief->'imported'->'shopify' IS NOT NULL;

    -- the product: a snapshot of the artwork, keyed on its own layers
    SELECT coalesce(jsonb_object_agg(m.new::text, m.old::text), '{}'::jsonb) INTO rmap FROM m_ids m JOIN flexiprint.ct_regions r ON r.id = m.old WHERE r.product_id = p.id;
    SELECT coalesce(jsonb_object_agg(m.new::text, m.old::text), '{}'::jsonb) INTO imap FROM m_ids m JOIN flexiprint.ct_region_items it ON it.id = m.old;
    UPDATE flexiprint.ct_products SET kind = 'product', base_product_id = b,
      config = config || jsonb_build_object('artworkRevision', 0, 'artworkLink', jsonb_build_object(
        'artworkId', a, 'revision', 1, 'regionMap', rmap, 'itemMap', imap, 'assetIds', aids, 'syncedAt', now()))
      WHERE id = p.id;
    RAISE NOTICE 'split % → artwork % (base %)', p.name, a, b;
  END LOOP;
END $$;

-- ---- 3. khuôn in: only the bases' ----
UPDATE ct_print_templates t SET spec = jsonb_set(t.spec, '{blanks}', coalesce(t.spec->'blanks', '[]'::jsonb) || coalesce((SELECT s.spec->'blanks' FROM ct_print_templates s WHERE s.id = '578024e5-246c-449f-aac5-2c362275f3d6'), '[]'::jsonb))
  WHERE t.id = 'c7081689-b078-4d02-846a-d7952a8d6b2b';
DELETE FROM ct_print_templates WHERE id NOT IN (SELECT (config->>'templateId')::uuid FROM ct_base_products WHERE config->>'templateId' IS NOT NULL);

NOTIFY pgrst, 'reload schema';
COMMIT;
