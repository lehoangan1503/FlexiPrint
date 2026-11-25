-- =====================================================
-- Customize Tool 041 — the server's MCP tools may write every table the pages write (2026-11-25)
--
-- MCP tools (server/mcp) run the pages' own handlers on a service-role session (serviceSession), so they need the
-- same table rights the signed-in user has. Several tables only ever granted service_role SELECT: "upload_font"
-- failed with "permission denied for table ct_settings", and save/delete_mockup_pack, link/unlink_library_main,
-- char_delete_set… hit the same wall. service_role already bypasses RLS: who may change what is checked by the
-- handlers (owner or admin), as on the pages.
--
-- Not covered on purpose: ct_ai_usage (the spend cap, written only through ct_ai_usage_hit).
--
-- Additive; run after 001–040. Re-runnable.
-- =====================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ct_products', 'ct_assets', 'ct_regions', 'ct_region_items', 'ct_generations', 'ct_templates',
    'ct_product_mains', 'ct_clipart_categories', 'ct_presets', 'ct_category_history', 'ct_preset_history',
    'ct_ai_styles', 'ct_mockup_packs', 'ct_pack_images', 'ct_pack_collections', 'ct_agent_tasks', 'ct_agent_inbox',
    'ct_price_tables', 'ct_settings', 'ct_char_projects', 'ct_char_images', 'ct_print_templates',
    'ct_base_products', 'ct_stores', 'ct_user_stores', 'ct_user_prefs', 'ct_secrets'
  ] LOOP
    IF to_regclass('flexiprint.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.%I TO service_role', t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
