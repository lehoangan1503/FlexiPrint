-- =====================================================
-- Customize Tool — category history
--
-- Every "Cập nhật bằng AI" of a category (server/ai/prompt-writer.ts
-- suggestCategoryRevision) and every save of a category leaves one row:
-- what the editor said was wrong (note + reference photos + the numbered
-- result images they looked at), the category as it was, and what the AI
-- proposed / what was finally saved. Kept so a person — or an agent through
-- the API / MCP — can see how a category's prompts came to be and why.
--
--   event 'revise'  input = the category before {name, spec, rules},
--                   result = the AI's CtCategoryRevision
--   event 'save'    input = {revision_id?}, result = the saved {name, spec, rules}
--
-- Rows go with their category. Additive; run after 001–009.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_category_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id  UUID REFERENCES flexiprint.ct_clipart_categories(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  event        TEXT NOT NULL CHECK (event IN ('revise', 'save')),
  note         TEXT NOT NULL DEFAULT '',
  ref_urls     TEXT[] NOT NULL DEFAULT '{}',
  image_urls   TEXT[] NOT NULL DEFAULT '{}',
  input        JSONB NOT NULL DEFAULT '{}'::jsonb,
  result       JSONB NOT NULL DEFAULT '{}'::jsonb,
  model        TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_category_history_category ON flexiprint.ct_category_history(category_id, created_at DESC);

ALTER TABLE flexiprint.ct_category_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ct_category_history_read" ON flexiprint.ct_category_history;
CREATE POLICY "ct_category_history_read" ON flexiprint.ct_category_history
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_category_history_insert" ON flexiprint.ct_category_history;
CREATE POLICY "ct_category_history_insert" ON flexiprint.ct_category_history
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT ON flexiprint.ct_category_history TO authenticated;
GRANT SELECT ON flexiprint.ct_category_history TO service_role;
