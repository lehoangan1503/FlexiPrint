-- =====================================================
-- Customize Tool 038 — the "Người đăng" filter of the Sản phẩm / Artwork list (asked 2026-11-24: "thi thoảng các
-- user để lọc sẽ hiện ra, thi thoảng lại không … lưu vào db để gọi ra")
--
-- The filter's people were taken from the page of products already loaded (100 newest): when those 100 were all
-- one person's, the filter vanished, and ticking a person only filtered that page. Now:
--   ct_product_owners(store, kind)  every poster of the store's list with how many they made — counted in the DB.
--   ct_user_prefs.list_owners       the people a user ticked, kept in the DB (was the browser's localStorage).
--
-- Additive; run after 001–037. Re-runnable.
-- =====================================================

SET search_path TO flexiprint, public;

CREATE TABLE IF NOT EXISTS flexiprint.ct_user_prefs (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  list_owners  UUID[] NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE flexiprint.ct_user_prefs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ct_user_prefs_own" ON flexiprint.ct_user_prefs;
CREATE POLICY "ct_user_prefs_own" ON flexiprint.ct_user_prefs FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_user_prefs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_user_prefs TO service_role;

-- Runs as the caller: counts only the rows the caller may read (same as the list itself).
CREATE OR REPLACE FUNCTION flexiprint.ct_product_owners(p_store TEXT, p_kind TEXT)
RETURNS TABLE (user_id UUID, name TEXT, n BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = flexiprint, public AS $$
  SELECT p.user_id, COALESCE(NULLIF(u.nickname, ''), u.email, '') AS name, COUNT(*) AS n
  FROM flexiprint.ct_products p
  LEFT JOIN flexiprint.user_profiles u ON u.user_id = p.user_id
  WHERE (p_store IS NULL OR p.store_id = p_store) AND (p_kind IS NULL OR p.kind = p_kind)
  GROUP BY p.user_id, u.nickname, u.email
  ORDER BY n DESC, name;
$$;
GRANT EXECUTE ON FUNCTION flexiprint.ct_product_owners(TEXT, TEXT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
