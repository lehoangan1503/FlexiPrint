-- =====================================================
-- Customize Tool 001 — 2D customizable products
-- =====================================================
-- One ct_products row is one sellable customizable product. Everything it is
-- built from hangs off it by foreign key:
--
--   ct_products ─┬─ main_asset_id ──► ct_assets (role 'main')
--                ├─ ct_assets        (main / sub / variant / composite / mockup / reference)
--                │     └─ parent_id ─► ct_assets   (variant → its sub asset)
--                │     └─ generation_id ─► ct_generations (which AI request made it)
--                ├─ ct_regions       (custom zones on the main asset)
--                │     └─ ct_region_items ─► ct_assets (sub assets placed in the zone)
--                └─ ct_generations   (every AI request: prompt, refs, model, outcome)
--
-- Deleting a product cascades to all of it. Storage objects are removed by the
-- API before the row goes, since Postgres cannot reach Storage.
--
-- Access: the whole team can READ (it is a shared design tool, like 2D
-- references); only the owner writes. Kept deliberately simple — the tool may
-- move to its own site, and these policies do not depend on host tables.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'archived')),
  main_asset_id UUID,
  thumbnail_url TEXT,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_products_updated
  ON flexiprint.ct_products(updated_at DESC);

CREATE TABLE IF NOT EXISTS flexiprint.ct_generations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id          UUID NOT NULL REFERENCES flexiprint.ct_products(id) ON DELETE CASCADE,
  target_role         TEXT NOT NULL CHECK (target_role IN ('main', 'sub', 'variant', 'composite', 'mockup', 'reference')),
  -- Kept as a plain uuid (no FK): the log must outlive a deleted parent asset.
  parent_asset_id     UUID,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  reference_asset_ids UUID[] NOT NULL DEFAULT '{}',
  params              JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ct_generations_product
  ON flexiprint.ct_generations(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS flexiprint.ct_assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES flexiprint.ct_products(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('main', 'sub', 'variant', 'composite', 'mockup', 'reference')),
  parent_id     UUID REFERENCES flexiprint.ct_assets(id) ON DELETE CASCADE,
  generation_id UUID REFERENCES flexiprint.ct_generations(id) ON DELETE SET NULL,
  name          TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  width         INTEGER NOT NULL DEFAULT 0,
  height        INTEGER NOT NULL DEFAULT 0,
  mime          TEXT NOT NULL DEFAULT 'image/png',
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A variant always belongs to a sub asset; nothing else has a parent.
  CONSTRAINT ct_assets_parent_only_for_variant
    CHECK ((role = 'variant') = (parent_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_ct_assets_product ON flexiprint.ct_assets(product_id, role, sort_order);
CREATE INDEX IF NOT EXISTS idx_ct_assets_parent  ON flexiprint.ct_assets(parent_id);

DO $$ BEGIN
  ALTER TABLE flexiprint.ct_products
    ADD CONSTRAINT ct_products_main_asset_fk
    FOREIGN KEY (main_asset_id) REFERENCES flexiprint.ct_assets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS flexiprint.ct_regions (
  -- Client-generated so the editor can reference a region before saving.
  id          UUID PRIMARY KEY,
  product_id  UUID NOT NULL REFERENCES flexiprint.ct_products(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL CHECK (kind IN ('image', 'text', 'photo')),
  shape       JSONB NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ct_regions_product ON flexiprint.ct_regions(product_id, sort_order);

CREATE TABLE IF NOT EXISTS flexiprint.ct_region_items (
  id          UUID PRIMARY KEY,
  region_id   UUID NOT NULL REFERENCES flexiprint.ct_regions(id) ON DELETE CASCADE,
  asset_id    UUID NOT NULL REFERENCES flexiprint.ct_assets(id) ON DELETE CASCADE,
  transform   JSONB NOT NULL DEFAULT '{"offsetX":0,"offsetY":0,"scale":1,"rotation":0}'::jsonb,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (region_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_ct_region_items_region ON flexiprint.ct_region_items(region_id, sort_order);

-- updated_at bump
CREATE OR REPLACE FUNCTION flexiprint.ct_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ct_products_touch ON flexiprint.ct_products;
CREATE TRIGGER trg_ct_products_touch
  BEFORE UPDATE ON flexiprint.ct_products
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

-- =====================================================
-- Save the whole design atomically.
-- =====================================================
-- The editor edits regions and their items together; saving them as separate
-- REST calls could leave a region without its items if one call failed. This
-- replaces the product's regions/items in one transaction. SECURITY INVOKER,
-- so the caller's RLS still decides whether the write is allowed.
CREATE OR REPLACE FUNCTION flexiprint.ct_save_design(
  p_product_id UUID,
  p_regions    JSONB,
  p_items      JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  DELETE FROM flexiprint.ct_regions WHERE product_id = p_product_id;

  INSERT INTO flexiprint.ct_regions (id, product_id, name, kind, shape, config, sort_order)
  SELECT (r->>'id')::uuid, p_product_id, COALESCE(r->>'name', ''), r->>'kind',
         r->'shape', COALESCE(r->'config', '{}'::jsonb), COALESCE((r->>'sort_order')::int, 0)
  FROM jsonb_array_elements(p_regions) AS r;

  INSERT INTO flexiprint.ct_region_items (id, region_id, asset_id, transform, is_default, sort_order)
  SELECT (i->>'id')::uuid, (i->>'region_id')::uuid, (i->>'asset_id')::uuid,
         COALESCE(i->'transform', '{"offsetX":0,"offsetY":0,"scale":1,"rotation":0}'::jsonb),
         COALESCE((i->>'is_default')::boolean, FALSE), COALESCE((i->>'sort_order')::int, 0)
  FROM jsonb_array_elements(p_items) AS i;

  UPDATE flexiprint.ct_products SET updated_at = NOW() WHERE id = p_product_id;
END $$;

GRANT EXECUTE ON FUNCTION flexiprint.ct_save_design(UUID, JSONB, JSONB) TO authenticated;

-- =====================================================
-- RLS
-- =====================================================
ALTER TABLE flexiprint.ct_products     ENABLE ROW LEVEL SECURITY;
ALTER TABLE flexiprint.ct_assets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE flexiprint.ct_regions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE flexiprint.ct_region_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE flexiprint.ct_generations  ENABLE ROW LEVEL SECURITY;

-- products
DROP POLICY IF EXISTS "ct_products_read" ON flexiprint.ct_products;
CREATE POLICY "ct_products_read" ON flexiprint.ct_products
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_products_write_own" ON flexiprint.ct_products;
CREATE POLICY "ct_products_write_own" ON flexiprint.ct_products
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- assets / generations carry their own user_id
DROP POLICY IF EXISTS "ct_assets_read" ON flexiprint.ct_assets;
CREATE POLICY "ct_assets_read" ON flexiprint.ct_assets
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_assets_write_own" ON flexiprint.ct_assets;
CREATE POLICY "ct_assets_write_own" ON flexiprint.ct_assets
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "ct_generations_read" ON flexiprint.ct_generations;
CREATE POLICY "ct_generations_read" ON flexiprint.ct_generations
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_generations_write_own" ON flexiprint.ct_generations;
CREATE POLICY "ct_generations_write_own" ON flexiprint.ct_generations
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- regions / items: writable by the owner of the product they belong to
DROP POLICY IF EXISTS "ct_regions_read" ON flexiprint.ct_regions;
CREATE POLICY "ct_regions_read" ON flexiprint.ct_regions
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_regions_write_own" ON flexiprint.ct_regions;
CREATE POLICY "ct_regions_write_own" ON flexiprint.ct_regions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM flexiprint.ct_products p WHERE p.id = product_id AND p.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM flexiprint.ct_products p WHERE p.id = product_id AND p.user_id = auth.uid()));

DROP POLICY IF EXISTS "ct_region_items_read" ON flexiprint.ct_region_items;
CREATE POLICY "ct_region_items_read" ON flexiprint.ct_region_items
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_region_items_write_own" ON flexiprint.ct_region_items;
CREATE POLICY "ct_region_items_write_own" ON flexiprint.ct_region_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM flexiprint.ct_regions r
    JOIN flexiprint.ct_products p ON p.id = r.product_id
    WHERE r.id = region_id AND p.user_id = auth.uid()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM flexiprint.ct_regions r
    JOIN flexiprint.ct_products p ON p.id = r.product_id
    WHERE r.id = region_id AND p.user_id = auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  flexiprint.ct_products,
  flexiprint.ct_assets,
  flexiprint.ct_regions,
  flexiprint.ct_region_items,
  flexiprint.ct_generations
TO authenticated;
