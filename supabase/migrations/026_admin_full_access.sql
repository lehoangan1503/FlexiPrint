-- =====================================================
-- Customize Tool — admins have full rights on everything
--
-- Admins (flexiprint.ct_is_admin(): app_metadata.role = 'admin' or user_profiles.role = 'admin') may read, add,
-- change and delete every row of every Customize Tool table, whoever created it: products, their zones and
-- assets, bộ nhân vật, library, styles, mockups, khuôn in, price tables… Policies are permissive, so this ORs
-- with each table's own owner policy; the table GRANTs stay as they are.
--
-- Not covered on purpose: user_profiles (roles are set by SQL only) and ct_ai_usage (the server's spend cap).
--
-- Additive; run after 001–025. Re-runnable.
-- =====================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ct_products', 'ct_assets', 'ct_regions', 'ct_region_items', 'ct_generations', 'ct_templates',
    'ct_product_mains', 'ct_clipart_categories', 'ct_presets', 'ct_category_history', 'ct_preset_history',
    'ct_ai_styles', 'ct_mockup_packs', 'ct_pack_images', 'ct_pack_collections', 'ct_agent_tasks',
    'ct_price_tables', 'ct_settings', 'ct_char_projects', 'ct_char_images', 'ct_print_templates'
  ] LOOP
    IF to_regclass('flexiprint.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON flexiprint.%I', t || '_admin_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON flexiprint.%I FOR ALL TO authenticated USING (flexiprint.ct_is_admin()) WITH CHECK (flexiprint.ct_is_admin())',
      t || '_admin_all', t
    );
  END LOOP;
END $$;
