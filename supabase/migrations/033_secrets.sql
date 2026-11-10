-- =====================================================
-- Customize Tool 033 — server-only secrets (asked 2026-11-11: "Import product base" from fulfillers)
--
--   ct_secrets   key → JSON that only the server (service role) reads and writes. First user: 'teeinblue' = the
--                Teeinblue portal login (session cookies + acting user) flexi2 uses to read Merchize's catalog and
--                import a Merchize product (Merchize has no public catalog API). Never readable by a signed-in
--                user through PostgREST: no policy for `authenticated`, no grant.
--
-- Additive; run after 001–032. Re-runnable.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_secrets (
  key         TEXT PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 80),
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS ct_secrets_touch ON flexiprint.ct_secrets;
CREATE TRIGGER ct_secrets_touch BEFORE UPDATE ON flexiprint.ct_secrets
  FOR EACH ROW EXECUTE FUNCTION flexiprint.ct_touch_updated_at();

ALTER TABLE flexiprint.ct_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON flexiprint.ct_secrets FROM authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_secrets TO service_role;

NOTIFY pgrst, 'reload schema';
