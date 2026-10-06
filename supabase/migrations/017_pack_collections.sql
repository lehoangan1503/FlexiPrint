-- =====================================================
-- Customize Tool — bộ ảnh (collections) of the thư viện ảnh tổ hợp
--
-- "Tạo ảnh với AI" works in a named bộ ảnh: every request of a bộ is a turn of one conversation with @flexiprint
-- (the bộ's tasks continue the same agent_ide session; get_task also hands the agent the bộ's earlier requests and
-- results), and the studio dialog shows the bộ as a chat thread. A task names its bộ in input.pack.collectionId;
-- photos carry collection_id (agent results, direct redraws, split layers).
--
-- Additive; run after 001–016.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_pack_collections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_pack_collections_user ON flexiprint.ct_pack_collections(user_id, updated_at DESC);

DROP TRIGGER IF EXISTS ct_pack_collections_touch ON flexiprint.ct_pack_collections;
CREATE TRIGGER ct_pack_collections_touch BEFORE UPDATE ON flexiprint.ct_pack_collections
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

ALTER TABLE flexiprint.ct_pack_collections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ct_pack_collections_read" ON flexiprint.ct_pack_collections;
CREATE POLICY "ct_pack_collections_read" ON flexiprint.ct_pack_collections
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_pack_collections_insert" ON flexiprint.ct_pack_collections;
CREATE POLICY "ct_pack_collections_insert" ON flexiprint.ct_pack_collections
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "ct_pack_collections_update" ON flexiprint.ct_pack_collections;
CREATE POLICY "ct_pack_collections_update" ON flexiprint.ct_pack_collections
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR flexiprint.ct_is_admin())
  WITH CHECK (user_id = auth.uid() OR flexiprint.ct_is_admin());
DROP POLICY IF EXISTS "ct_pack_collections_delete" ON flexiprint.ct_pack_collections;
CREATE POLICY "ct_pack_collections_delete" ON flexiprint.ct_pack_collections
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR flexiprint.ct_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_pack_collections TO authenticated;
GRANT SELECT, UPDATE ON flexiprint.ct_pack_collections TO service_role;

ALTER TABLE flexiprint.ct_pack_images ADD COLUMN IF NOT EXISTS collection_id UUID REFERENCES flexiprint.ct_pack_collections(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ct_pack_images_collection ON flexiprint.ct_pack_images(collection_id, created_at);

NOTIFY pgrst, 'reload schema';
