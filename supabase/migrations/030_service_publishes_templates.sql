-- =====================================================
-- Customize Tool 030 — the agent's deploy publishes templates (found 2026-10-30)
--
-- MCP deploy_product (customize-tool/server/mcp/deploy-tools.ts) runs runDeploy with the service-role client, and
-- its first step writes the next ct_templates version — which service_role could only read (005), so every agent
-- deploy failed with "permission denied for table ct_templates".
--
-- Additive; run after 001–029. Re-runnable.
-- =====================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON flexiprint.ct_templates TO service_role;
