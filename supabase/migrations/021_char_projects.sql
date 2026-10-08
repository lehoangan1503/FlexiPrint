-- =====================================================
-- Customize Tool v2 — bộ nhân vật (character sets made from ONE AI master)
--
-- A project = a brief (product, characters, what the customer may change, text, decor, mockups) → master pictures
-- the editor reviews (several candidates, refinements as in-place edits) → ONE approved master → in-place edits
-- (part masks, removed parts, option shapes/textures) → pixel-registered layers → products. Every picture of a
-- project lives in ct_char_images (one row per file, so background jobs never overwrite each other); the rules
-- are flexiprint://guide/layer-rules.
--
-- Additive; run after 001–020.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_char_projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  name        TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 200),
  brief       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Brainstorm answers (style directions + proposed briefs), newest last.
  ideas       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The approved master (ct_char_images.id); null while the editor is still choosing.
  master_id   UUID,
  status      TEXT NOT NULL DEFAULT 'brief' CHECK (status IN ('brief', 'master', 'layers', 'product')),
  -- Layer set made from the approved master (manifest + checks), see server/char/layers.ts.
  layers      JSONB NOT NULL DEFAULT '{}'::jsonb,
  product_ids UUID[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_char_projects_user ON flexiprint.ct_char_projects(user_id, updated_at DESC);

DROP TRIGGER IF EXISTS ct_char_projects_touch ON flexiprint.ct_char_projects;
CREATE TRIGGER ct_char_projects_touch BEFORE UPDATE ON flexiprint.ct_char_projects
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

CREATE TABLE IF NOT EXISTS flexiprint.ct_char_images (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES flexiprint.ct_char_projects(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  -- ref: style / blank-product photo the editor gave · master: candidate or refinement · edit: in-place edit of
  -- the approved master · layer: an output layer file · mockup: product photo.
  kind         TEXT NOT NULL CHECK (kind IN ('ref', 'blank', 'master', 'edit', 'layer', 'mockup')),
  -- What the file is for, e.g. "remove:c1:hair", "mask:c1:sweater", "shape:c1:hair:bob" (server/char/plan.ts).
  role         TEXT NOT NULL DEFAULT '',
  parent_id    UUID REFERENCES flexiprint.ct_char_images(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('running', 'done', 'failed')),
  prompt       TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  model        TEXT NOT NULL DEFAULT '',
  -- Original (print quality) and a small WebP for the web page.
  url          TEXT NOT NULL DEFAULT '',
  storage_path TEXT NOT NULL DEFAULT '',
  thumb_url    TEXT NOT NULL DEFAULT '',
  thumb_path   TEXT NOT NULL DEFAULT '',
  width        INT,
  height       INT,
  -- Registration check of an edit against the master (dx, dy, unchanged share), errors of a step…
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  error        TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_char_images_project ON flexiprint.ct_char_images(project_id, created_at);

DROP TRIGGER IF EXISTS ct_char_images_touch ON flexiprint.ct_char_images;
CREATE TRIGGER ct_char_images_touch BEFORE UPDATE ON flexiprint.ct_char_images
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

ALTER TABLE flexiprint.ct_char_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE flexiprint.ct_char_images ENABLE ROW LEVEL SECURITY;

-- The team sees every set (reuse); the owner (or an admin) changes it.
DROP POLICY IF EXISTS "ct_char_projects_read" ON flexiprint.ct_char_projects;
CREATE POLICY "ct_char_projects_read" ON flexiprint.ct_char_projects
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_char_projects_insert" ON flexiprint.ct_char_projects;
CREATE POLICY "ct_char_projects_insert" ON flexiprint.ct_char_projects
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "ct_char_projects_update" ON flexiprint.ct_char_projects;
CREATE POLICY "ct_char_projects_update" ON flexiprint.ct_char_projects
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR flexiprint.ct_is_admin())
  WITH CHECK (user_id = auth.uid() OR flexiprint.ct_is_admin());
DROP POLICY IF EXISTS "ct_char_projects_delete" ON flexiprint.ct_char_projects;
CREATE POLICY "ct_char_projects_delete" ON flexiprint.ct_char_projects
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR flexiprint.ct_is_admin());

DROP POLICY IF EXISTS "ct_char_images_read" ON flexiprint.ct_char_images;
CREATE POLICY "ct_char_images_read" ON flexiprint.ct_char_images
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ct_char_images_insert" ON flexiprint.ct_char_images;
CREATE POLICY "ct_char_images_insert" ON flexiprint.ct_char_images
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM flexiprint.ct_char_projects p WHERE p.id = project_id AND (p.user_id = auth.uid() OR flexiprint.ct_is_admin()))
  );
DROP POLICY IF EXISTS "ct_char_images_update" ON flexiprint.ct_char_images;
CREATE POLICY "ct_char_images_update" ON flexiprint.ct_char_images
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM flexiprint.ct_char_projects p WHERE p.id = project_id AND (p.user_id = auth.uid() OR flexiprint.ct_is_admin())))
  WITH CHECK (EXISTS (SELECT 1 FROM flexiprint.ct_char_projects p WHERE p.id = project_id AND (p.user_id = auth.uid() OR flexiprint.ct_is_admin())));
DROP POLICY IF EXISTS "ct_char_images_delete" ON flexiprint.ct_char_images;
CREATE POLICY "ct_char_images_delete" ON flexiprint.ct_char_images
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM flexiprint.ct_char_projects p WHERE p.id = project_id AND (p.user_id = auth.uid() OR flexiprint.ct_is_admin())));

GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_char_projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_char_images TO authenticated;
-- Background jobs (AI pictures finishing after the request answered) and the @flexiprint MCP write with the service key.
GRANT SELECT, INSERT, UPDATE ON flexiprint.ct_char_projects TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_char_images TO service_role;

NOTIFY pgrst, 'reload schema';
