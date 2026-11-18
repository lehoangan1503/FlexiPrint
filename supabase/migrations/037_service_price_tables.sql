-- =====================================================
-- Customize Tool 037 — MCP create_base_product writes price tables (2026-11-18)
--
-- create_base_product (customize-tool/server/mcp/deploy-tools.ts) makes the base's price table with the service-role
-- client, which could only read ct_price_tables: "permission denied for table ct_price_tables".
--
-- Additive; run after 001–036. Re-runnable.
-- =====================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_price_tables TO service_role;
