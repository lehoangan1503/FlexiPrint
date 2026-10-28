-- =====================================================
-- Customize Tool 029 — a bộ ảnh khách's own AI styles (asked 2026-10-28)
--
-- @flexiprint writes the styles of a bộ ảnh khách (customize-tool/server/char/photo-styles.ts) as ct_ai_styles rows
-- (params.setId = the set) and tests them in background jobs, all with the service-role client — which so far could
-- only read the table (005). Lookup of a set's styles by params->>setId gets an index.
--
-- Additive; run after 001–028. Re-runnable.
-- =====================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_ai_styles TO service_role;

CREATE INDEX IF NOT EXISTS ct_ai_styles_set_idx ON flexiprint.ct_ai_styles ((params ->> 'setId'));
