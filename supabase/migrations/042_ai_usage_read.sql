-- =====================================================
-- Customize Tool 042 — the server may READ the AI spend counters (2026-11-26)
--
-- The multi-photo popup shows the customer how many AI drawings they have left today (GET public/quota,
-- server/ai-styles.ts aiQuotaLeft). ct_ai_usage only had rights for postgres: the read failed ("permission denied"),
-- so the popup could not show the number (and takeAiQuota's "which cap tripped" read always answered "per customer").
-- Read only: the counters are still written only through ct_ai_usage_hit (041 left them out on purpose).
--
-- Additive; run after 001–041. Re-runnable.
-- =====================================================

GRANT SELECT ON flexiprint.ct_ai_usage TO service_role;
