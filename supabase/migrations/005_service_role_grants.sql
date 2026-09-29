-- Customize Tool — table grants for the service role.
--
-- The public storefront endpoints (public/templates, public/uploads,
-- public/photo) have no signed-in user, so they read through the
-- service-role client (server/supabase.ts ctServiceClient). service_role
-- bypasses RLS but still needs table privileges in this schema, and 001–003
-- only granted `authenticated`. Without this the storefront gets
-- "permission denied for table ct_templates" (verified 2026-09-29) and the
-- product page shows no personalization form.
--
-- Read-only on purpose: the public side never writes these tables (uploads
-- go to Storage; the AI spend counter is the ct_ai_usage_hit RPC from 003).

SET search_path TO flexiprint, public;

GRANT USAGE ON SCHEMA flexiprint TO service_role;
GRANT SELECT ON flexiprint.ct_templates TO service_role;
-- loadAiStyle(): the prompt / model of an "ai:<id>" style (server/ai-styles.ts).
GRANT SELECT ON flexiprint.ct_ai_styles TO service_role;
