-- =====================================================
-- Customize Tool — style pack / material analysis history
--
-- Every "Phân tích bằng AI" in the preset dialog (server/ai/prompt-writer.ts
-- suggestPresetPrompt) and every save of a style pack / material leaves one
-- row: what the editor described (note + reference photos), the prompt it
-- started from, and what the AI wrote / what was finally saved. Kept so a
-- person — or later an agent through the API / MCP — can see how a preset
-- came to be and why, and reuse an earlier analysis.
--
--   event 'analysis'  input = {name, prompt (before)}, result = {name, prompt, specs?, art?}
--   event 'save'      result = the saved preset {name, prompt, params}
--
-- preset_id is NULL for an analysis of a preset not saved yet; the create
-- call links it (history_ids). Rows go with their preset.
--
-- Additive; run after 001–007.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_preset_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  preset_id   UUID REFERENCES flexiprint.ct_presets(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  kind        TEXT NOT NULL CHECK (kind IN ('style_pack', 'material')),
  event       TEXT NOT NULL CHECK (event IN ('analysis', 'save')),
  note        TEXT NOT NULL DEFAULT '',
  ref_urls    TEXT[] NOT NULL DEFAULT '{}',
  input       JSONB NOT NULL DEFAULT '{}'::jsonb,
  result      JSONB NOT NULL DEFAULT '{}'::jsonb,
  model       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_preset_history_preset ON flexiprint.ct_preset_history(preset_id, created_at DESC);

ALTER TABLE flexiprint.ct_preset_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ct_preset_history_read" ON flexiprint.ct_preset_history;
CREATE POLICY "ct_preset_history_read" ON flexiprint.ct_preset_history
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_preset_history_insert" ON flexiprint.ct_preset_history;
CREATE POLICY "ct_preset_history_insert" ON flexiprint.ct_preset_history
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
-- Only to link an analysis to the preset created from it.
DROP POLICY IF EXISTS "ct_preset_history_update" ON flexiprint.ct_preset_history;
CREATE POLICY "ct_preset_history_update" ON flexiprint.ct_preset_history
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE ON flexiprint.ct_preset_history TO authenticated;
GRANT SELECT ON flexiprint.ct_preset_history TO service_role;
