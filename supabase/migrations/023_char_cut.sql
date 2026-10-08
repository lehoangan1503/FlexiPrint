-- =====================================================
-- Customize Tool — v2 bộ nhân vật: the cut is reviewed on the master before files are made
--
-- ct_char_projects.cut = {matte, plan} (types/char.ts CtCharCut): the master without its backdrop (alpha the editor
-- fixes by hand), then the region of every layer on its picture (fixed by hand too); layer files are cut from both.
--
-- Additive; run after 001–022.
-- =====================================================

SET search_path TO flexiprint, public;

ALTER TABLE flexiprint.ct_char_projects ADD COLUMN IF NOT EXISTS cut JSONB;

NOTIFY pgrst, 'reload schema';
