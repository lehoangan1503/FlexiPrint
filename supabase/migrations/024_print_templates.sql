-- =====================================================
-- Customize Tool — Khuôn in (print templates), reused by every product printed on the same piece
--
-- A template is what the printer needs, independent of any design: the print file's size (px / mm / dpi), the cut
-- line, the safe zone(s), the parts that must stay empty (a hanging hole, cut out of the print), and the named zones
-- a layer can fill (the legs / waistband of a pair of trousers). Sizes (S…4XL) carry their own canvas; their zones
-- default to the base ones scaled. The overlay picture (the printer's "CIRCLE CERAMIC ORNAMENT 1000×1000" sheet) and
-- a straight photo of the blank piece are optional. Shape / units: lib/print-template.ts (CtPrintSpec).
--
-- ct_products.config.print = the spec a product was made from (a copy: editing a template never moves a product's
-- layers; the editor offers to update).
--
-- Additive; run after 001–023.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_print_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  name        TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 200),
  -- flat: one piece cut to a geometric outline (ornament, tile, poster) · cut: outline = the artwork's own alpha
  -- (sticker, acrylic) · panels: several named zones on one sheet, sizes (all-over-print trousers, pillows)
  kind        TEXT NOT NULL DEFAULT 'flat' CHECK (kind IN ('flat', 'cut', 'panels')),
  spec        JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_print_templates_order ON flexiprint.ct_print_templates(sort_order, created_at);

DROP TRIGGER IF EXISTS ct_print_templates_touch ON flexiprint.ct_print_templates;
CREATE TRIGGER ct_print_templates_touch BEFORE UPDATE ON flexiprint.ct_print_templates
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

ALTER TABLE flexiprint.ct_print_templates ENABLE ROW LEVEL SECURITY;

-- Shared by the team (a material is reused across designs); the owner (or an admin) changes it.
DROP POLICY IF EXISTS "ct_print_templates_read" ON flexiprint.ct_print_templates;
CREATE POLICY "ct_print_templates_read" ON flexiprint.ct_print_templates
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_print_templates_insert" ON flexiprint.ct_print_templates;
CREATE POLICY "ct_print_templates_insert" ON flexiprint.ct_print_templates
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "ct_print_templates_update" ON flexiprint.ct_print_templates;
CREATE POLICY "ct_print_templates_update" ON flexiprint.ct_print_templates
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR flexiprint.ct_is_admin())
  WITH CHECK (user_id = auth.uid() OR flexiprint.ct_is_admin());
DROP POLICY IF EXISTS "ct_print_templates_delete" ON flexiprint.ct_print_templates;
CREATE POLICY "ct_print_templates_delete" ON flexiprint.ct_print_templates
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR flexiprint.ct_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_print_templates TO authenticated;
-- The @flexiprint MCP reads / writes with the service key.
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_print_templates TO service_role;

-- The @flexiprint MCP makes products on a template (create_artwork_product / set_artwork_layers): it writes the
-- product, its sheet, its layers and their pictures with the service key.
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_products TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_assets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_regions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_region_items TO service_role;
GRANT EXECUTE ON FUNCTION flexiprint.ct_save_design(UUID, JSONB, JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';
