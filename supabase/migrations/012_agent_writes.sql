-- =====================================================
-- Customize Tool — the @flexiprint agent saves (flexiprint-mcp write tools)
--
-- When a person asks @flexiprint directly on agent_ide, the agent saves
-- categories and presets itself (customize-tool/server/mcp/write-tools.ts),
-- through the service role. Every save is checked like the web app's, refused
-- if the row changed since the agent read it, and leaves a history row
-- (before + after, model 'agent:flexiprint') that restore_category can put back.
--
-- No delete: the agent never removes a category, preset or clipart.
-- Additive; run after 001–011.
-- =====================================================

SET search_path TO flexiprint, public;

GRANT INSERT, UPDATE ON flexiprint.ct_clipart_categories TO service_role;
GRANT INSERT, UPDATE ON flexiprint.ct_presets TO service_role;
GRANT INSERT ON flexiprint.ct_category_history, flexiprint.ct_preset_history TO service_role;
