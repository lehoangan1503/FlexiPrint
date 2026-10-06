-- =====================================================
-- Customize Tool — team-wide settings (key → JSON value)
--
-- ct_settings 'image_model': the image model every AI picture is made with (studio clipart gốc / đa sắc /
-- vật liệu / sửa, ảnh tổ hợp), picked on the home page. Absent = the default in lib/image-models.ts.
--
-- Additive; run after 001–019.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_settings (
  key         TEXT PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 80),
  value       JSONB NOT NULL,
  updated_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS ct_settings_touch ON flexiprint.ct_settings;
CREATE TRIGGER ct_settings_touch BEFORE UPDATE ON flexiprint.ct_settings
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

ALTER TABLE flexiprint.ct_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ct_settings_read" ON flexiprint.ct_settings;
CREATE POLICY "ct_settings_read" ON flexiprint.ct_settings FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_settings_insert" ON flexiprint.ct_settings;
CREATE POLICY "ct_settings_insert" ON flexiprint.ct_settings FOR INSERT TO authenticated WITH CHECK (TRUE);
DROP POLICY IF EXISTS "ct_settings_update" ON flexiprint.ct_settings;
CREATE POLICY "ct_settings_update" ON flexiprint.ct_settings FOR UPDATE TO authenticated USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT, INSERT, UPDATE ON flexiprint.ct_settings TO authenticated;
GRANT SELECT ON flexiprint.ct_settings TO service_role;

NOTIFY pgrst, 'reload schema';
