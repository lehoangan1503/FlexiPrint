-- =====================================================
-- Customize Tool 002 — main versions + published templates (Shopify)
-- =====================================================
-- ct_products.config      product-level option config (main versions:
--                         { "main": { "enabled", "label", "display" } }).
--                         Saved together with the design.
-- ct_templates            immutable, versioned snapshot written by "Publish".
--                         The storefront section (shopify/sections/
--                         main-product.liquid) loads the latest one through
--                         GET /api/customize-tool/public/templates/:productId.
--
-- The public endpoints read/write with the service-role key on the server, so
-- nothing here is granted to `anon`.
-- =====================================================

SET search_path TO flexiprint, public;

ALTER TABLE flexiprint.ct_products
  ADD COLUMN IF NOT EXISTS config            JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS published_version INTEGER,
  ADD COLUMN IF NOT EXISTS published_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS flexiprint.ct_templates (
  product_id   UUID NOT NULL REFERENCES flexiprint.ct_products(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  template     JSONB NOT NULL,
  published_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, version)
);

ALTER TABLE flexiprint.ct_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ct_templates_read" ON flexiprint.ct_templates;
CREATE POLICY "ct_templates_read" ON flexiprint.ct_templates
  FOR SELECT TO authenticated USING (TRUE);

-- Only the product owner publishes. No UPDATE/DELETE policy: versions are
-- immutable (an order carries "_ct_template = <product>@v<N>" and must keep
-- resolving to what the customer saw); they go away with the product.
DROP POLICY IF EXISTS "ct_templates_insert_own" ON flexiprint.ct_templates;
CREATE POLICY "ct_templates_insert_own" ON flexiprint.ct_templates
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM flexiprint.ct_products p WHERE p.id = product_id AND p.user_id = auth.uid()));

GRANT SELECT, INSERT ON flexiprint.ct_templates TO authenticated;
