-- =====================================================
-- Customize Tool 031 — Product base · Artwork · Sản phẩm (asked 2026-11-07, like Teeinblue Product Base / Artwork /
-- Campaign)
--
--   ct_base_products   the blank product sold: its type ("Acrylic Ornament 1 side"), the Notion price table that
--                      makes its variants (Size × Pack), its print area(s), the khuôn in + phôi of the piece, fulfiller
--                      info. No design. Its mockups are the mockups of every product made from it.
--   ct_products.kind   'artwork' = a design (layers, options, versions, khuôn, preview, print file) — every set,
--                      import and hand-made design is one; 'product' = what is sold = a base product + a SNAPSHOT of a
--                      finished artwork (config.artworkLink), with its own mockups and its Shopify link.
--   ct_products.base_product_id  the base product a 'product' row is made on.
--
-- Additive; run after 001–030. Re-runnable.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_base_products (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS ct_base_products_touch ON flexiprint.ct_base_products;
CREATE TRIGGER ct_base_products_touch BEFORE UPDATE ON flexiprint.ct_base_products
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

ALTER TABLE flexiprint.ct_base_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ct_base_products_read" ON flexiprint.ct_base_products;
CREATE POLICY "ct_base_products_read" ON flexiprint.ct_base_products
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_base_products_insert" ON flexiprint.ct_base_products;
CREATE POLICY "ct_base_products_insert" ON flexiprint.ct_base_products
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "ct_base_products_update" ON flexiprint.ct_base_products;
CREATE POLICY "ct_base_products_update" ON flexiprint.ct_base_products
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR flexiprint.ct_is_admin())
  WITH CHECK (user_id = auth.uid() OR flexiprint.ct_is_admin());
DROP POLICY IF EXISTS "ct_base_products_delete" ON flexiprint.ct_base_products;
CREATE POLICY "ct_base_products_delete" ON flexiprint.ct_base_products
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR flexiprint.ct_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_base_products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_base_products TO service_role;

ALTER TABLE flexiprint.ct_products ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'artwork';
ALTER TABLE flexiprint.ct_products DROP CONSTRAINT IF EXISTS ct_products_kind_check;
ALTER TABLE flexiprint.ct_products ADD CONSTRAINT ct_products_kind_check CHECK (kind IN ('artwork', 'product'));
ALTER TABLE flexiprint.ct_products ADD COLUMN IF NOT EXISTS base_product_id UUID REFERENCES flexiprint.ct_base_products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ct_products_kind ON flexiprint.ct_products(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_products_base ON flexiprint.ct_products(base_product_id);

NOTIFY pgrst, 'reload schema';
