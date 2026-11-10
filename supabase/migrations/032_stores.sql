-- =====================================================
-- Customize Tool 032 — several Shopify stores (asked 2026-11-10: "switch store ở /dashboard, dùng chung product
-- base, thư viện; các cái khác là độc lập")
--
--   ct_stores           the Shopify stores FlexiPrint sells on (CHERIVIA, Caridora…): name, myshopify domain, public
--                       site. The app's credentials are NOT here — they are env vars (server/stores.ts).
--   ct_user_stores      the store each user works on now (the /dashboard switch).
--   ct_products.store_id  every artwork and product belongs to ONE store. A new row with no store_id gets its owner's
--                       current store (trigger below) — so every path (dashboard, editor, MCP, imports, set builds)
--                       lands in the store its user has picked; a product made from an artwork takes the artwork's.
--   Shared by every store: product bases, price tables, the library (bộ clipart, khuôn, phôi, fonts, AI styles).
--
-- Additive; run after 001–031. Re-runnable. Every row that exists before it = CHERIVIA.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_stores (
  id           TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  shop_domain  TEXT NOT NULL,
  public_url   TEXT NOT NULL DEFAULT '',
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO flexiprint.ct_stores (id, name, shop_domain, public_url, sort_order) VALUES
  ('cherivia', 'CHERIVIA', 'v5bpim-cd.myshopify.com', 'https://cherivia.com', 0),
  ('caridora', 'Caridora', 'v1ebmg-u1.myshopify.com', 'https://caridora.com', 1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE flexiprint.ct_stores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ct_stores_read" ON flexiprint.ct_stores;
CREATE POLICY "ct_stores_read" ON flexiprint.ct_stores FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_stores_admin" ON flexiprint.ct_stores;
CREATE POLICY "ct_stores_admin" ON flexiprint.ct_stores FOR ALL TO authenticated USING (flexiprint.ct_is_admin()) WITH CHECK (flexiprint.ct_is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_stores TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_stores TO service_role;

CREATE TABLE IF NOT EXISTS flexiprint.ct_user_stores (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  store_id    TEXT NOT NULL REFERENCES flexiprint.ct_stores(id) ON DELETE CASCADE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE flexiprint.ct_user_stores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ct_user_stores_own" ON flexiprint.ct_user_stores;
CREATE POLICY "ct_user_stores_own" ON flexiprint.ct_user_stores FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_user_stores TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_user_stores TO service_role;

ALTER TABLE flexiprint.ct_products ADD COLUMN IF NOT EXISTS store_id TEXT REFERENCES flexiprint.ct_stores(id);
UPDATE flexiprint.ct_products SET store_id = 'cherivia' WHERE store_id IS NULL;
ALTER TABLE flexiprint.ct_products ALTER COLUMN store_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ct_products_store ON flexiprint.ct_products(store_id, kind, created_at DESC);

-- A row inserted without a store: its owner's current store, else the first store.
CREATE OR REPLACE FUNCTION flexiprint.ct_products_store_default() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = flexiprint, public AS $$
BEGIN
  IF NEW.store_id IS NULL THEN
    SELECT store_id INTO NEW.store_id FROM flexiprint.ct_user_stores WHERE user_id = NEW.user_id;
    IF NEW.store_id IS NULL THEN
      SELECT id INTO NEW.store_id FROM flexiprint.ct_stores ORDER BY sort_order, created_at LIMIT 1;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ct_products_store_default ON flexiprint.ct_products;
CREATE TRIGGER ct_products_store_default BEFORE INSERT ON flexiprint.ct_products
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_products_store_default();

NOTIFY pgrst, 'reload schema';
