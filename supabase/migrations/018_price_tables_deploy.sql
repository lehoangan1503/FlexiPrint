-- =====================================================
-- Customize Tool — bảng giá + Deploy sản phẩm lên Shopify
--
-- ct_price_tables: named price tables (Size × Pack "Buy More Save More"), shared by every editor; the Deploy page
-- picks one and turns it into the Shopify product's options + variants (server/shopify.ts).
-- ct_products.shopify: the product's link to its Shopify product (id, handle, chosen price table, media ids, last
-- deploy) — kept out of `config`, which the design save rewrites.
--
-- Additive; run after 001–017.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_price_tables (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_price_tables_updated ON flexiprint.ct_price_tables(updated_at DESC);

DROP TRIGGER IF EXISTS ct_price_tables_touch ON flexiprint.ct_price_tables;
CREATE TRIGGER ct_price_tables_touch BEFORE UPDATE ON flexiprint.ct_price_tables
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

ALTER TABLE flexiprint.ct_price_tables ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ct_price_tables_read" ON flexiprint.ct_price_tables;
CREATE POLICY "ct_price_tables_read" ON flexiprint.ct_price_tables
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_price_tables_insert" ON flexiprint.ct_price_tables;
CREATE POLICY "ct_price_tables_insert" ON flexiprint.ct_price_tables
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "ct_price_tables_update" ON flexiprint.ct_price_tables;
CREATE POLICY "ct_price_tables_update" ON flexiprint.ct_price_tables
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR flexiprint.ct_is_admin())
  WITH CHECK (user_id = auth.uid() OR flexiprint.ct_is_admin());
DROP POLICY IF EXISTS "ct_price_tables_delete" ON flexiprint.ct_price_tables;
CREATE POLICY "ct_price_tables_delete" ON flexiprint.ct_price_tables
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR flexiprint.ct_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_price_tables TO authenticated;
GRANT SELECT ON flexiprint.ct_price_tables TO service_role;

ALTER TABLE flexiprint.ct_products ADD COLUMN IF NOT EXISTS shopify JSONB;

NOTIFY pgrst, 'reload schema';
