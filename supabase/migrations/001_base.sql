-- =====================================================
-- FlexiPrint — base schema: accounts + profiles
-- Schema: flexiprint (exposed to PostgREST via PGRST_DB_SCHEMAS)
-- Files live on Cloudflare R2, so there is no storage bucket here.
-- =====================================================

CREATE SCHEMA IF NOT EXISTS flexiprint;
GRANT USAGE ON SCHEMA flexiprint TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION flexiprint.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------
-- user_profiles: one row per auth user (nickname + tool role)
--
--   superadmin  auth.users.raw_app_meta_data.role = 'admin' (SQL only, see supabase/README.md)
--   admin       user_profiles.role = 'admin'  — tool admin (shared AI style library)
--   mode        user_profiles.role = 'mode'
--   NULL        normal user
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS flexiprint.user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  nickname VARCHAR(50),
  email TEXT NOT NULL,
  role VARCHAR(20) CONSTRAINT user_profiles_role_check CHECK (role IS NULL OR role IN ('mode', 'admin')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON flexiprint.user_profiles (role) WHERE role IS NOT NULL;

DROP TRIGGER IF EXISTS trigger_user_profiles_updated_at ON flexiprint.user_profiles;
CREATE TRIGGER trigger_user_profiles_updated_at
  BEFORE UPDATE ON flexiprint.user_profiles
  FOR EACH ROW EXECUTE FUNCTION flexiprint.update_updated_at();

ALTER TABLE flexiprint.user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read all profiles" ON flexiprint.user_profiles;
CREATE POLICY "Authenticated users can read all profiles"
  ON flexiprint.user_profiles FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Users can insert own profile" ON flexiprint.user_profiles;
CREATE POLICY "Users can insert own profile"
  ON flexiprint.user_profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- Users edit their own nickname; the role column is changed only by the service role
-- (admin dashboard), see the column grant below.
DROP POLICY IF EXISTS "Users can update own profile" ON flexiprint.user_profiles;
CREATE POLICY "Users can update own profile"
  ON flexiprint.user_profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id);

GRANT SELECT, INSERT ON flexiprint.user_profiles TO authenticated;
GRANT UPDATE (nickname, email) ON flexiprint.user_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.user_profiles TO service_role;

-- -----------------------------------------------------
-- New auth user → profile row
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION flexiprint.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = flexiprint, public
AS $$
BEGIN
  INSERT INTO flexiprint.user_profiles (user_id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION flexiprint.handle_new_user();
