-- =====================================================
-- Customize Tool — bộ tổ hợp (mockup sets)
--
-- A tổ hợp is a mockup made by hand in the editor's "Tổ hợp" tab: a
-- background photo, FRAMES (a main version with its customisation, drawn
-- with its material) and extras (hand photo, text, size arrows, detail
-- circles) — types/index.ts CtPackSlide, lib/mockup.ts renders it. Each one
-- is saved on the product as a mockup asset (meta.scene). A named set of
-- them lives here and is reused by every product of the kind: frames name
-- their version by position, so each product puts its own versions there.
--
-- slides = the scenes; width / height = the first scene's canvas; slots is
-- unused (kept for the shape of the table).
--
-- Additive; run after 001–006.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_mockup_packs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  name           TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  notes          TEXT NOT NULL DEFAULT '',
  width          INTEGER NOT NULL DEFAULT 2000 CHECK (width BETWEEN 256 AND 4096),
  height         INTEGER NOT NULL DEFAULT 2000 CHECK (height BETWEEN 256 AND 4096),
  slots          JSONB NOT NULL DEFAULT '[]'::jsonb,
  slides         JSONB NOT NULL DEFAULT '[]'::jsonb,
  thumbnail_url  TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_mockup_packs_order ON flexiprint.ct_mockup_packs(sort_order, created_at);

DROP TRIGGER IF EXISTS ct_mockup_packs_touch ON flexiprint.ct_mockup_packs;
CREATE TRIGGER ct_mockup_packs_touch BEFORE UPDATE ON flexiprint.ct_mockup_packs
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

ALTER TABLE flexiprint.ct_mockup_packs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ct_mockup_packs_read" ON flexiprint.ct_mockup_packs;
CREATE POLICY "ct_mockup_packs_read" ON flexiprint.ct_mockup_packs
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_mockup_packs_insert" ON flexiprint.ct_mockup_packs;
CREATE POLICY "ct_mockup_packs_insert" ON flexiprint.ct_mockup_packs
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "ct_mockup_packs_update" ON flexiprint.ct_mockup_packs;
CREATE POLICY "ct_mockup_packs_update" ON flexiprint.ct_mockup_packs
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR flexiprint.ct_is_admin())
  WITH CHECK (user_id = auth.uid() OR flexiprint.ct_is_admin());
DROP POLICY IF EXISTS "ct_mockup_packs_delete" ON flexiprint.ct_mockup_packs;
CREATE POLICY "ct_mockup_packs_delete" ON flexiprint.ct_mockup_packs
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR flexiprint.ct_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_mockup_packs TO authenticated;
GRANT SELECT ON flexiprint.ct_mockup_packs TO service_role;
