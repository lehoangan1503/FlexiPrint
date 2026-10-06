-- =====================================================
-- Customize Tool — thư viện ảnh tổ hợp (photo library for tổ hợp)
--
-- Every photo used in a tổ hợp Image frame lives here, so it can be reused
-- in later edits and by the @flexiprint agent (MCP list_pack_images) before
-- searching the web or generating more:
--   source 'upload'  a photo an editor uploaded (renamed before upload)
--   source 'ai'      made by "Tạo ảnh với AI": the editor's description +
--                    reference photos (refs) → FlexiPrint writes `prompt`
--                    (LLM) → image `model` draws it. status running → done
--                    | failed (error); the row is the generation history.
-- Shared like the clipart library: everyone signed in reads, owners (or an
-- admin) change / delete.
--
-- Additive; run after 001–014.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_pack_images (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  source        TEXT NOT NULL CHECK (source IN ('upload', 'ai')),
  status        TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('running', 'done', 'failed')),
  url           TEXT,
  storage_path  TEXT,
  mime          TEXT,
  width         INTEGER,
  height        INTEGER,
  description   TEXT NOT NULL DEFAULT '',
  prompt        TEXT NOT NULL DEFAULT '',
  refs          JSONB NOT NULL DEFAULT '[]'::jsonb,
  aspect        TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_pack_images_created ON flexiprint.ct_pack_images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_pack_images_user ON flexiprint.ct_pack_images(user_id, created_at DESC);

DROP TRIGGER IF EXISTS ct_pack_images_touch ON flexiprint.ct_pack_images;
CREATE TRIGGER ct_pack_images_touch BEFORE UPDATE ON flexiprint.ct_pack_images
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

ALTER TABLE flexiprint.ct_pack_images ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ct_pack_images_read" ON flexiprint.ct_pack_images;
CREATE POLICY "ct_pack_images_read" ON flexiprint.ct_pack_images
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_pack_images_insert" ON flexiprint.ct_pack_images;
CREATE POLICY "ct_pack_images_insert" ON flexiprint.ct_pack_images
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "ct_pack_images_update" ON flexiprint.ct_pack_images;
CREATE POLICY "ct_pack_images_update" ON flexiprint.ct_pack_images
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR flexiprint.ct_is_admin())
  WITH CHECK (user_id = auth.uid() OR flexiprint.ct_is_admin());
DROP POLICY IF EXISTS "ct_pack_images_delete" ON flexiprint.ct_pack_images;
CREATE POLICY "ct_pack_images_delete" ON flexiprint.ct_pack_images
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR flexiprint.ct_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_pack_images TO authenticated;
GRANT SELECT, INSERT, UPDATE ON flexiprint.ct_pack_images TO service_role;

-- PostgREST picks the new table up without a restart.
NOTIFY pgrst, 'reload schema';
