-- =====================================================
-- Customize Tool — table privileges for admins' full access
--
-- 026 gave admins (superadmin app_metadata.role = 'admin' and tool admin user_profiles.role = 'admin', both via
-- flexiprint.ct_is_admin()) an ALL policy on every ct_ table, but a policy only applies where the role has the
-- table privilege: these tables never granted UPDATE / DELETE to `authenticated`. Everyone else stays limited by
-- the tables' own policies (none of them allows these commands to non-admins).
--
-- Additive; run after 001–026. Re-runnable.
-- =====================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON
  flexiprint.ct_agent_tasks,
  flexiprint.ct_category_history,
  flexiprint.ct_preset_history,
  flexiprint.ct_settings,
  flexiprint.ct_templates
TO authenticated;
