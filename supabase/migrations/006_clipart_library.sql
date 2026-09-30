-- =====================================================
-- Customize Tool 006 — global clipart library + prompt presets
-- =====================================================
-- Cliparts stop belonging to one product. ct_assets IS the clipart table:
--
--   product_id NULL      a library clipart, reusable by every product
--   product_id NOT NULL  a product-only asset (composites, mockups, references,
--                        and cliparts not promoted to the library yet)
--
-- A library clipart hangs off a category:
--
--   ct_clipart_categories ─┬─ usage  'main'    origins are main objects (steamer, each car model)
--                          │         'element' origins go into image zones (dumpling, hat, hobby icon)
--                          ├─ mode   'origin_set'   independent originals of one kind (6 car models)
--                          │         'variant_set'  one silhouette, many colours / styles (10 dumplings)
--                          ├─ spec   shared prompt for the whole category
--                          └─ rules  canvas / fill / anchor / background / lockSilhouette … (CtCategoryRules)
--
--   ct_assets (library)    origin     parent_id NULL, role 'main' | 'sub'
--                          set member parent_id → origin, role 'variant' (element) | 'main' (main)
--                          rendition  parent_id → any clipart, role 'rendition': AI material
--                                     version (acrylic, glitter…) with the SAME silhouette/size,
--                                     shown on the storefront; print files keep the flat art.
--
-- Products reference library cliparts two ways:
--   ct_region_items.asset_id   an element placed into an image zone (unchanged)
--   ct_product_mains           main versions picked from the library
--
-- ct_presets holds reusable prompts: style packs (how every clipart of a set
-- is drawn), materials (acrylic, wood…) and scenes (mockup backgrounds).
-- ComfyUI nodes (services/comfy) read both tables through the internal API.
--
-- Additive; run after 001–005.
-- =====================================================

SET search_path TO flexiprint, public;

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS flexiprint.ct_clipart_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  parent_id   UUID REFERENCES flexiprint.ct_clipart_categories(id) ON DELETE SET NULL,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  usage       TEXT NOT NULL DEFAULT 'element' CHECK (usage IN ('main', 'element')),
  mode        TEXT NOT NULL DEFAULT 'origin_set' CHECK (mode IN ('origin_set', 'variant_set')),
  spec        TEXT NOT NULL DEFAULT '',
  rules       JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_clipart_categories_parent ON flexiprint.ct_clipart_categories(parent_id, sort_order);

DROP TRIGGER IF EXISTS ct_clipart_categories_touch ON flexiprint.ct_clipart_categories;
CREATE TRIGGER ct_clipart_categories_touch BEFORE UPDATE ON flexiprint.ct_clipart_categories
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Assets become cliparts
-- ---------------------------------------------------------------------------

ALTER TABLE flexiprint.ct_assets ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE flexiprint.ct_assets ADD COLUMN IF NOT EXISTS category_id UUID
  REFERENCES flexiprint.ct_clipart_categories(id) ON DELETE SET NULL;
ALTER TABLE flexiprint.ct_assets ADD COLUMN IF NOT EXISTS spec    TEXT NOT NULL DEFAULT '';
ALTER TABLE flexiprint.ct_assets ADD COLUMN IF NOT EXISTS tags    TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE flexiprint.ct_assets ADD COLUMN IF NOT EXISTS source  TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE flexiprint.ct_assets ADD COLUMN IF NOT EXISTS license TEXT NOT NULL DEFAULT '';

ALTER TABLE flexiprint.ct_assets DROP CONSTRAINT IF EXISTS ct_assets_role_check;
ALTER TABLE flexiprint.ct_assets ADD CONSTRAINT ct_assets_role_check
  CHECK (role IN ('main', 'sub', 'variant', 'rendition', 'composite', 'mockup', 'reference'));

ALTER TABLE flexiprint.ct_assets DROP CONSTRAINT IF EXISTS ct_assets_source_check;
ALTER TABLE flexiprint.ct_assets ADD CONSTRAINT ct_assets_source_check
  CHECK (source IN ('upload', 'ai', 'stock'));

-- variant / rendition always have a parent; a main may (a colour of a main origin); nothing else does.
ALTER TABLE flexiprint.ct_assets DROP CONSTRAINT IF EXISTS ct_assets_parent_only_for_variant;
ALTER TABLE flexiprint.ct_assets DROP CONSTRAINT IF EXISTS ct_assets_parent_rule;
ALTER TABLE flexiprint.ct_assets ADD CONSTRAINT ct_assets_parent_rule CHECK (
  CASE
    WHEN role IN ('variant', 'rendition') THEN parent_id IS NOT NULL
    WHEN role = 'main' THEN TRUE
    ELSE parent_id IS NULL
  END
);

-- Only cliparts live in the library; composites / mockups / references stay per product.
ALTER TABLE flexiprint.ct_assets DROP CONSTRAINT IF EXISTS ct_assets_library_roles;
ALTER TABLE flexiprint.ct_assets ADD CONSTRAINT ct_assets_library_roles
  CHECK (product_id IS NOT NULL OR role IN ('main', 'sub', 'variant', 'rendition'));

CREATE INDEX IF NOT EXISTS idx_ct_assets_library
  ON flexiprint.ct_assets(category_id, sort_order) WHERE product_id IS NULL;

-- Library cliparts are shared: admins may edit anyone's; owners edit their own.
DROP POLICY IF EXISTS "ct_assets_write_own" ON flexiprint.ct_assets;
CREATE POLICY "ct_assets_write_own" ON flexiprint.ct_assets
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR (product_id IS NULL AND flexiprint.ct_is_admin()))
  WITH CHECK (user_id = auth.uid() OR (product_id IS NULL AND flexiprint.ct_is_admin()));

-- ---------------------------------------------------------------------------
-- Main versions picked from the library
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS flexiprint.ct_product_mains (
  product_id  UUID NOT NULL REFERENCES flexiprint.ct_products(id) ON DELETE CASCADE,
  asset_id    UUID NOT NULL REFERENCES flexiprint.ct_assets(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_ct_product_mains_asset ON flexiprint.ct_product_mains(asset_id);

-- ---------------------------------------------------------------------------
-- Prompt presets
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS flexiprint.ct_presets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  kind                TEXT NOT NULL CHECK (kind IN ('style_pack', 'material', 'scene')),
  name                TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  prompt              TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 6000),
  reference_asset_ids UUID[] NOT NULL DEFAULT '{}',
  params              JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_presets_kind ON flexiprint.ct_presets(kind, sort_order);

DROP TRIGGER IF EXISTS ct_presets_touch ON flexiprint.ct_presets;
CREATE TRIGGER ct_presets_touch BEFORE UPDATE ON flexiprint.ct_presets
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Generation log: library generations have no product; ComfyUI runs keep their graph.
-- ---------------------------------------------------------------------------

ALTER TABLE flexiprint.ct_generations ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE flexiprint.ct_generations ADD COLUMN IF NOT EXISTS category_id UUID
  REFERENCES flexiprint.ct_clipart_categories(id) ON DELETE SET NULL;
ALTER TABLE flexiprint.ct_generations ADD COLUMN IF NOT EXISTS resolved_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE flexiprint.ct_generations ADD COLUMN IF NOT EXISTS workflow JSONB;
ALTER TABLE flexiprint.ct_generations DROP CONSTRAINT IF EXISTS ct_generations_target_role_check;
ALTER TABLE flexiprint.ct_generations ADD CONSTRAINT ct_generations_target_role_check
  CHECK (target_role IN ('main', 'sub', 'variant', 'rendition', 'composite', 'mockup', 'reference'));

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE flexiprint.ct_clipart_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE flexiprint.ct_product_mains      ENABLE ROW LEVEL SECURITY;
ALTER TABLE flexiprint.ct_presets            ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ct_clipart_categories_read" ON flexiprint.ct_clipart_categories;
CREATE POLICY "ct_clipart_categories_read" ON flexiprint.ct_clipart_categories
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_clipart_categories_insert" ON flexiprint.ct_clipart_categories;
CREATE POLICY "ct_clipart_categories_insert" ON flexiprint.ct_clipart_categories
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "ct_clipart_categories_update" ON flexiprint.ct_clipart_categories;
CREATE POLICY "ct_clipart_categories_update" ON flexiprint.ct_clipart_categories
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR flexiprint.ct_is_admin())
  WITH CHECK (user_id = auth.uid() OR flexiprint.ct_is_admin());
DROP POLICY IF EXISTS "ct_clipart_categories_delete" ON flexiprint.ct_clipart_categories;
CREATE POLICY "ct_clipart_categories_delete" ON flexiprint.ct_clipart_categories
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR flexiprint.ct_is_admin());

DROP POLICY IF EXISTS "ct_product_mains_read" ON flexiprint.ct_product_mains;
CREATE POLICY "ct_product_mains_read" ON flexiprint.ct_product_mains
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_product_mains_write_own" ON flexiprint.ct_product_mains;
CREATE POLICY "ct_product_mains_write_own" ON flexiprint.ct_product_mains
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM flexiprint.ct_products p WHERE p.id = product_id AND p.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM flexiprint.ct_products p WHERE p.id = product_id AND p.user_id = auth.uid()));

DROP POLICY IF EXISTS "ct_presets_read" ON flexiprint.ct_presets;
CREATE POLICY "ct_presets_read" ON flexiprint.ct_presets
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_presets_insert" ON flexiprint.ct_presets;
CREATE POLICY "ct_presets_insert" ON flexiprint.ct_presets
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "ct_presets_update" ON flexiprint.ct_presets;
CREATE POLICY "ct_presets_update" ON flexiprint.ct_presets
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR flexiprint.ct_is_admin())
  WITH CHECK (user_id = auth.uid() OR flexiprint.ct_is_admin());
DROP POLICY IF EXISTS "ct_presets_delete" ON flexiprint.ct_presets;
CREATE POLICY "ct_presets_delete" ON flexiprint.ct_presets
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR flexiprint.ct_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  flexiprint.ct_clipart_categories,
  flexiprint.ct_product_mains,
  flexiprint.ct_presets
TO authenticated;

-- ComfyUI studio (server/studio.ts internal API) acts through the service role.
GRANT SELECT ON flexiprint.ct_products, flexiprint.ct_product_mains TO service_role;
GRANT SELECT, INSERT, UPDATE ON flexiprint.ct_assets, flexiprint.ct_generations TO service_role;
GRANT SELECT ON flexiprint.ct_clipart_categories, flexiprint.ct_presets TO service_role;

-- ---------------------------------------------------------------------------
-- Built-in presets (owner NULL → admins edit)
-- ---------------------------------------------------------------------------

INSERT INTO flexiprint.ct_presets (user_id, kind, name, prompt, params, sort_order)
SELECT NULL, v.kind, v.name, v.prompt, v.params::jsonb, v.sort_order
FROM (VALUES
  ('style_pack', 'Kawaii glossy sticker',
   'Cute kawaii clipart in a polished 3D-ish sticker style: soft rounded shapes, glossy highlights, smooth gradients, subtle rim light, clean dark-brown outlines of even weight, saturated but soft pastel palette, big shiny eyes when the subject has a face. Single isolated subject, front view, no scenery, no text, no drop shadow.',
   '{}', 0),
  ('material', 'Acrylic trong (clear)',
   'Render this exact artwork as a printed CLEAR ACRYLIC ornament, 3 mm thick. Keep every shape, colour, line and letter of the artwork exactly as given — same silhouette, same size, same position. Add only the material: a thin transparent acrylic edge that follows the silhouette with a subtle white rim, soft glassy specular highlights across the surface, faint refraction at the edge. Plain pure white background, straight-on front view, no perspective change, no added objects.',
   '{"lockSilhouette": true}', 0),
  ('material', 'Acrylic trắng (white backing)',
   'Render this exact artwork as a printed acrylic plaque with a WHITE backing, 3 mm thick. Keep every shape, colour, line and letter exactly as given — same silhouette, same size, same position. Add only the material: a glossy lacquered surface with soft specular highlights and a thin bright acrylic edge following the outline. Plain pure white background, straight-on front view, no perspective change, no added objects.',
   '{"lockSilhouette": true}', 1),
  ('material', 'Glitter',
   'Keep this exact clipart — same silhouette, same size, same colours and same details — and cover its coloured surfaces with fine sparkling holographic glitter: tiny reflective flakes, small four-point star sparkles, a soft pearly sheen. Do not change the outline, the face or any line work. Plain pure white background.',
   '{"lockSilhouette": true}', 2),
  ('material', 'Gỗ khắc (wood)',
   'Render this exact artwork as UV-printed onto a light birch plywood cut-out, 3 mm thick. Keep every shape, colour and letter exactly as given; let a faint wood grain show through light areas, add a thin natural plywood edge following the silhouette. Plain pure white background, straight-on front view, no added objects.',
   '{"lockSilhouette": true}', 3),
  ('material', 'Nhôm (aluminum)',
   'Render this exact artwork as printed on a brushed aluminum sheet: keep every shape, colour and letter exactly as given, add a subtle brushed-metal sheen in light areas and a thin bevelled metallic edge. Plain pure white background, straight-on front view, no added objects.',
   '{"lockSilhouette": true}', 4),
  ('material', 'Gốm bóng (ceramic gloss)',
   'Render this exact artwork as fired onto glossy white porcelain: keep every shape, colour and letter exactly as given, add a smooth glazed surface with one soft window-light highlight and gentle curvature shading near the rim. Plain pure white background, straight-on front view, no added objects.',
   '{"lockSilhouette": true}', 5),
  ('scene', 'Cây thông Giáng sinh bokeh',
   'Photorealistic product photo: the ornament from the reference image hangs on a gold string from a real Christmas fir branch, warm fairy-light bokeh in the dark green background, shallow depth of field, soft cinematic light. Reproduce the ornament EXACTLY — every shape, colour and letter unchanged — only add realistic lighting and the acrylic edge.',
   '{}', 0)
) AS v(kind, name, prompt, params, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM flexiprint.ct_presets p WHERE p.user_id IS NULL AND p.kind = v.kind AND p.name = v.name);
