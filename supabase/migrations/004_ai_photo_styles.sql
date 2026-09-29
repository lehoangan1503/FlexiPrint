-- =====================================================
-- Customize Tool 003 — AI photo styles + spend caps
-- =====================================================
-- ct_ai_styles   Global library of AI restyle presets for customer photos
--                ("Watercolor + Ink" …): prompt + fal.ai model + params.
--                Everyone signed in reads and creates; the owner edits /
--                deletes their own; admins (tool admin or superadmin) edit
--                all. user_id NULL = built-in preset (admins only).
--                A photo zone offers a style as "ai:<id>". The prompt and
--                model NEVER go to the storefront: the public photo endpoint
--                resolves the id on the server, the published template only
--                carries { ref, name }.
-- ct_ai_usage    Durable per-day counters for the public photo endpoint
--                (per IP + global), so a spammer can't burn the fal.ai
--                balance. Only the service role touches it, through
--                ct_ai_usage_hit().
--
-- Additive only. Run after 001 and 002.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_ai_styles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  prompt      TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 4000),
  model       TEXT NOT NULL,
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION flexiprint.ct_touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ct_ai_styles_touch ON flexiprint.ct_ai_styles;
CREATE TRIGGER ct_ai_styles_touch BEFORE UPDATE ON flexiprint.ct_ai_styles
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

-- Tool admin (user_profiles.role) or superadmin (app_metadata.role), same as src/lib/auth/roles.ts.
CREATE OR REPLACE FUNCTION flexiprint.ct_is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = flexiprint, public AS $$
  SELECT COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
      OR EXISTS (SELECT 1 FROM flexiprint.user_profiles up WHERE up.user_id = auth.uid() AND up.role = 'admin');
$$;

ALTER TABLE flexiprint.ct_ai_styles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ct_ai_styles_read" ON flexiprint.ct_ai_styles;
CREATE POLICY "ct_ai_styles_read" ON flexiprint.ct_ai_styles
  FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS "ct_ai_styles_insert" ON flexiprint.ct_ai_styles;
CREATE POLICY "ct_ai_styles_insert" ON flexiprint.ct_ai_styles
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "ct_ai_styles_update" ON flexiprint.ct_ai_styles;
CREATE POLICY "ct_ai_styles_update" ON flexiprint.ct_ai_styles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR flexiprint.ct_is_admin())
  WITH CHECK (user_id = auth.uid() OR flexiprint.ct_is_admin());

DROP POLICY IF EXISTS "ct_ai_styles_delete" ON flexiprint.ct_ai_styles;
CREATE POLICY "ct_ai_styles_delete" ON flexiprint.ct_ai_styles
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR flexiprint.ct_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_ai_styles TO authenticated;
GRANT EXECUTE ON FUNCTION flexiprint.ct_is_admin() TO authenticated;

-- Built-in preset (owner NULL → only admins edit it).
INSERT INTO flexiprint.ct_ai_styles (user_id, name, prompt, model, params, sort_order)
SELECT NULL,
       'Watercolor + Ink',
       'A watercolor and simple ink sketch illustration of the exact subject from the reference image on a pure white background. Preserve the subject''s original expression, pose, proportions, and key features exactly. Use clean, confident black ink outlines with sharp, well-defined edges around the subject. Combine with soft watercolor effects: visible brush strokes, gentle color bleeding, light washes, and subtle pigment textures. Keep the style minimal, elegant, and hand-painted, ensuring the subject remains clear, recognizable, and visually crisp with strong black outlines.',
       'fal-ai/nano-banana/edit',
       '{"resolution": "1K", "aspect": "1:1", "whiteBackground": true, "removeBackground": true, "outputFormat": "png"}'::jsonb,
       0
WHERE NOT EXISTS (SELECT 1 FROM flexiprint.ct_ai_styles WHERE user_id IS NULL AND name = 'Watercolor + Ink');

-- ---------------------------------------------------------------------------
-- Spend caps
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS flexiprint.ct_ai_usage (
  day     DATE NOT NULL,
  bucket  TEXT NOT NULL,          -- 'all' | 'ip:<sha256>'
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bucket)
);
ALTER TABLE flexiprint.ct_ai_usage ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (bypasses RLS) reads/writes it.

-- Atomically count one AI call against every bucket; false (and nothing counted) if any is at its limit.
CREATE OR REPLACE FUNCTION flexiprint.ct_ai_usage_hit(p_buckets TEXT[], p_limits INTEGER[]) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = flexiprint, public AS $$
DECLARE
  i INTEGER;
  n INTEGER;
BEGIN
  FOR i IN 1 .. array_length(p_buckets, 1) LOOP
    INSERT INTO flexiprint.ct_ai_usage (day, bucket, count) VALUES (CURRENT_DATE, p_buckets[i], 0)
      ON CONFLICT (day, bucket) DO NOTHING;
    SELECT count INTO n FROM flexiprint.ct_ai_usage WHERE day = CURRENT_DATE AND bucket = p_buckets[i] FOR UPDATE;
    IF n >= p_limits[i] THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  UPDATE flexiprint.ct_ai_usage SET count = count + 1 WHERE day = CURRENT_DATE AND bucket = ANY (p_buckets);
  RETURN TRUE;
END $$;

REVOKE ALL ON FUNCTION flexiprint.ct_ai_usage_hit(TEXT[], INTEGER[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION flexiprint.ct_ai_usage_hit(TEXT[], INTEGER[]) TO service_role;
