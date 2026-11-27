-- =====================================================
-- Customize Tool 043 — give back an AI drawing that failed (2026-11-27)
--
-- ct_ai_usage_hit counts a drawing BEFORE the model runs (the cap must hold while it runs). When the drawing then
-- fails (timeout, network, model error) the customer got nothing: the server calls this to undo that count
-- (server/ai-styles.ts refundAiQuota). 27/11 a busy an-vm failed every task of a multi-photo popup and the customer
-- still saw "AI drawings left today: 85/100".
--
-- Never below 0. Today's row only (a drawing started before midnight and failed after it is not given back).
-- Additive; run after 001–042. Re-runnable.
-- =====================================================

CREATE OR REPLACE FUNCTION flexiprint.ct_ai_usage_refund(p_buckets TEXT[]) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = flexiprint, public AS $$
  UPDATE flexiprint.ct_ai_usage SET count = count - 1
   WHERE day = CURRENT_DATE AND bucket = ANY (p_buckets) AND count > 0;
$$;

REVOKE ALL ON FUNCTION flexiprint.ct_ai_usage_refund(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION flexiprint.ct_ai_usage_refund(TEXT[]) TO service_role;
